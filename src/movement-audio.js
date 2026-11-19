const KEY='okazaki-movement-sound-v1';
export function readSoundSettings(storage) {
  try{const v=JSON.parse(storage?.getItem(KEY)??'null');if(v&&typeof v.enabled==='boolean'&&Number.isFinite(v.volume))return {enabled:v.enabled,volume:Math.max(0,Math.min(1,v.volume))};}catch{}
  return {enabled:true,volume:.35};
}
const firstStepDistance = .18;

export function movementSoundProfile({active,grounded,flying,boosting,speed,gait}) {
  if(!active||!Number.isFinite(speed)||speed<.35)return {mode:'silent',interval:0,jet:0};
  if(grounded&&!flying && (gait === undefined || gait === 'walk' || gait === 'run')) {
    const running = gait === 'run';
    const stride = running ? Math.min(2, 1 + speed * .17) : Math.min(1.9, .85 + speed * .25);
    return {mode:'steps', gait:running ? 'run' : 'walk', stride, interval:stride/speed, jet:0};
  }
  if(flying)return {mode:boosting?'jet':'wind',interval:0,jet:Math.min(boosting?.42:.20,.025+speed/(boosting?140:220))};
  return {mode:'silent',interval:0,jet:0};
}

// Bake four short mono shoe contacts on unlock. The heel, sole and scuff share
// an envelope per contact, with different timing and weight for each gait.
function makeFootstep(context, running, right) {
  const rate = context.sampleRate, duration = running ? .19 : .23;
  const buffer = context.createBuffer(1, Math.ceil(rate * duration), rate);
  const samples = buffer.getChannelData(0);
  const toeDelay = (running ? .031 : .072) + (right ? .004 : 0);
  const pitch = (running ? 78 : 109) * (right ? .96 : 1.04);
  const soleFilter = 1 - Math.exp(-2 * Math.PI * (running ? 480 : 360) / rate);
  const scuffFilter = 1 - Math.exp(-2 * Math.PI * (right ? 2100 : 2500) / rate);
  let sole = 0, scuff = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate, toeTime = Math.max(0, t - toeDelay);
    const grit = Math.random() * 2 - 1;
    sole += soleFilter * (grit - sole);
    scuff += scuffFilter * (grit - scuff);
    const heel = (1 - Math.exp(-t * 760)) * Math.exp(-t * (running ? 37 : 48));
    const toe = (1 - Math.exp(-toeTime * 220)) * Math.exp(-toeTime * 37);
    // A short downward pitch bend gives the heel weight even on laptop speakers.
    const thump = Math.sin(2 * Math.PI * (pitch * t + .92 * (1 - Math.exp(-t * 55))));
    const contact = heel * ((running ? .61 : .37) * thump + .47 * sole);
    const soleAndScuff = toe * (.56 * sole + (running ? .31 : .22) * (scuff - sole));
    samples[i] = (contact + soleAndScuff) * Math.min(1, (duration - t) / .012);
  }
  return buffer;
}
export function createMovementAudio({storage=null,eventTarget=globalThis.window,isAllowed=()=>true,
  contextFactory=()=>new(globalThis.AudioContext??globalThis.webkitAudioContext)()}={}) {
  let settings=readSoundSettings(storage),context=null,master,engineGain,humGain,filter,noise,oscillator,noiseBuffer;
  let stepBuffers, currentStep = null, remainingStride = firstStepDistance;
  let lastPosition=null,lastTime=null,lastGrounded=false,steps=0,jetGain=0,mode='silent',gait=null,disposed=false,unlocking=null;
  function stop(){
    jetGain=0;mode='silent';gait=null;remainingStride=firstStepDistance;
    lastPosition=null;lastTime=null;lastGrounded=false;
    if(context){
      master.gain.cancelScheduledValues(context.currentTime);master.gain.setValueAtTime(0,context.currentTime);
      engineGain.gain.cancelScheduledValues(context.currentTime);engineGain.gain.setValueAtTime(0,context.currentTime);
      humGain.gain.cancelScheduledValues(context.currentTime);humGain.gain.setValueAtTime(0,context.currentTime);
      currentStep?.stop();currentStep=null;
    }
  }
  async function unlock(){
    if(disposed||!settings.enabled||!isAllowed())return false;
    if(unlocking)return unlocking;
    unlocking=Promise.resolve().then(async()=>{try{
      if(!context){
        context=contextFactory();master=context.createGain();master.gain.value=0;master.connect(context.destination);
        engineGain=context.createGain();engineGain.gain.value=0;engineGain.connect(master);
        humGain=context.createGain();humGain.gain.value=0;humGain.connect(master);
        noiseBuffer=context.createBuffer(1,context.sampleRate*2,context.sampleRate);const samples=noiseBuffer.getChannelData(0);let brown=0;
        for(let i=0;i<samples.length;i++){brown=(brown+(Math.random()*2-1)*.03)/1.03;samples[i]=brown*3;}
        stepBuffers = {
          walk: [makeFootstep(context, false, false), makeFootstep(context, false, true)],
          run: [makeFootstep(context, true, false), makeFootstep(context, true, true)],
        };
        noise=context.createBufferSource();noise.buffer=noiseBuffer;noise.loop=true;filter=context.createBiquadFilter();filter.type='lowpass';filter.frequency.value=900;noise.connect(filter);filter.connect(engineGain);noise.start();
        oscillator=context.createOscillator();oscillator.type='sine';oscillator.frequency.value=55;oscillator.connect(humGain);oscillator.start();
      }
      if(context.state==='suspended')await context.resume();return context.state==='running';
    }catch{try{await context?.close();}catch{}context=null;return false;}}).finally(()=>{unlocking=null;});return unlocking;
  }
  function footstep(currentGait){
    const source = context.createBufferSource();
    source.buffer = stepBuffers[currentGait][steps % 2];
    source.connect(master);
    source.onended = () => {
      source.disconnect();
      if (currentStep === source) currentStep = null;
    };
    source.start();currentStep=source;steps++;
  }
  const gesture=e=>{if(e.isTrusted)void unlock();};
  eventTarget?.addEventListener('pointerdown',gesture,{capture:true});eventTarget?.addEventListener('keydown',gesture,{capture:true});eventTarget?.addEventListener('blur',stop);
  return {
    unlock,
    setSettings(value){settings={enabled:Boolean(value.enabled??settings.enabled),volume:Math.max(0,Math.min(1,Number.isFinite(value.volume)?value.volume:settings.volume))};try{storage?.setItem(KEY,JSON.stringify(settings));}catch{}if(!settings.enabled||settings.volume===0)stop();},
    update({time,position,active,grounded=false,flying=false,boosting=false,gait:requestedGait}){
      if (!active || !settings.enabled || !settings.volume || disposed) {
        if (lastPosition) stop();
        return;
      }
      const dt = lastTime === null ? 0 : (time - lastTime) / 1000;
      const horizontal = lastPosition ? Math.hypot(position[0]-lastPosition[0],position[2]-lastPosition[2]) : 0;
      const travel = lastPosition ? Math.hypot(horizontal,position[1]-lastPosition[1]) : 0;
      const onFoot = grounded && !flying;
      let speed = dt > 0 && dt < 1.5 && travel < 15 ? travel / dt : 0;
      if (onFoot) {
        // Ignore landing, teleports and suspended-tab gaps. Vertical movement
        // on slopes never counts toward a footfall.
        speed = lastGrounded && dt > 0 && dt <= .5 && horizontal <= 9 * dt && travel < 15 ? horizontal / dt : 0;
      }
      lastPosition=[...position];lastTime=time;lastGrounded=onFoot;
      const profile=movementSoundProfile({active,grounded,flying,boosting,speed,gait:requestedGait});
      mode=profile.mode;gait=profile.gait??null;jetGain=profile.jet;
      if(!context||context.state!=='running'){jetGain=0;remainingStride=firstStepDistance;return;}
      const now=context.currentTime;
      master.gain.setTargetAtTime(profile.mode==='silent'?0:settings.volume*.65,now,.025);
      engineGain.gain.setTargetAtTime(profile.jet,now,.09);humGain.gain.setTargetAtTime(profile.jet*.14,now,.12);
      filter.frequency.setTargetAtTime(650+Math.min(80,speed)*25,now,.1);oscillator.frequency.setTargetAtTime(45+Math.min(80,speed)*.8,now,.1);
      if (gait) {
        remainingStride -= horizontal;
        if (remainingStride <= 0) {
          footstep(gait);
          // Keep the phase across coarse display frames without emitting a
          // burst of simultaneous impacts after a hitch.
          remainingStride = profile.stride - (-remainingStride % profile.stride);
        }
      } else remainingStride = firstStepDistance;
    },
    stop,
    getState:()=>({...settings,unlocked:Boolean(context),contextState:context?.state??'locked',steps,jetGain,mode,gait}),
    dispose(){disposed=true;stop();eventTarget?.removeEventListener('pointerdown',gesture,{capture:true});eventTarget?.removeEventListener('keydown',gesture,{capture:true});eventTarget?.removeEventListener('blur',stop);noise?.stop();oscillator?.stop();void context?.close();}
  };
}
