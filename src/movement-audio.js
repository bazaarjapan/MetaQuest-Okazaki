const KEY='okazaki-movement-sound-v1';
export function readSoundSettings(storage) {
  try{const v=JSON.parse(storage?.getItem(KEY)??'null');if(v&&typeof v.enabled==='boolean'&&Number.isFinite(v.volume))return {enabled:v.enabled,volume:Math.max(0,Math.min(1,v.volume))};}catch{}
  return {enabled:true,volume:.35};
}
export function movementSoundProfile({active,grounded,flying,boosting,speed}) {
  if(!active||!Number.isFinite(speed)||speed<.35)return {mode:'silent',interval:0,jet:0};
  if(grounded&&!flying)return {mode:'steps',interval:Math.max(.23,.54-speed*.025),jet:0};
  if(flying)return {mode:boosting?'jet':'wind',interval:0,jet:Math.min(boosting?.42:.20,.025+speed/(boosting?140:220))};
  return {mode:'silent',interval:0,jet:0};
}
export function createMovementAudio({storage=null,eventTarget=globalThis.window,isAllowed=()=>true,
  contextFactory=()=>new(globalThis.AudioContext??globalThis.webkitAudioContext)()}={}) {
  let settings=readSoundSettings(storage),context=null,master,engineGain,humGain,filter,noise,oscillator,noiseBuffer;
  let lastPosition=null,lastTime=null,nextStep=0,steps=0,jetGain=0,mode='silent',disposed=false,unlocking=null;
  function stop(){jetGain=0;mode='silent';nextStep=0;if(context){master.gain.cancelScheduledValues(context.currentTime);master.gain.setValueAtTime(0,context.currentTime);engineGain.gain.cancelScheduledValues(context.currentTime);engineGain.gain.setValueAtTime(0,context.currentTime);humGain.gain.cancelScheduledValues(context.currentTime);humGain.gain.setValueAtTime(0,context.currentTime);}}
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
        noise=context.createBufferSource();noise.buffer=noiseBuffer;noise.loop=true;filter=context.createBiquadFilter();filter.type='lowpass';filter.frequency.value=900;noise.connect(filter);filter.connect(engineGain);noise.start();
        oscillator=context.createOscillator();oscillator.type='sine';oscillator.frequency.value=55;oscillator.connect(humGain);oscillator.start();
      }
      if(context.state==='suspended')await context.resume();return context.state==='running';
    }catch{try{await context?.close();}catch{}context=null;return false;}}).finally(()=>{unlocking=null;});return unlocking;
  }
  function footstep(){
    const now=context.currentTime,source=context.createBufferSource(),low=context.createBiquadFilter(),gain=context.createGain();
    source.buffer=noiseBuffer;source.playbackRate.value=steps%2?.93:1.07;low.type='lowpass';low.frequency.value=1050;
    gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(.8,now+.006);gain.gain.exponentialRampToValueAtTime(.001,now+.14);
    source.connect(low);low.connect(gain);gain.connect(master);source.onended=()=>{source.disconnect();low.disconnect();gain.disconnect();};source.start(now,(steps*.173)%1);source.stop(now+.15);steps++;
  }
  const gesture=e=>{if(e.isTrusted)void unlock();};
  eventTarget?.addEventListener('pointerdown',gesture,{capture:true});eventTarget?.addEventListener('keydown',gesture,{capture:true});eventTarget?.addEventListener('blur',stop);
  return {
    unlock,
    setSettings(value){settings={enabled:Boolean(value.enabled??settings.enabled),volume:Math.max(0,Math.min(1,Number.isFinite(value.volume)?value.volume:settings.volume))};try{storage?.setItem(KEY,JSON.stringify(settings));}catch{}if(!settings.enabled||settings.volume===0)stop();},
    update({time,position,active,grounded=false,flying=false,boosting=false}){
      const dt=lastTime===null?0:(time-lastTime)/1000,distance=lastPosition?Math.hypot(...position.map((v,i)=>v-lastPosition[i])):0;
      const speed=dt>0&&dt<1.5&&distance<15?distance/dt:0;lastPosition=[...position];lastTime=time;
      const profile=movementSoundProfile({active:active&&settings.enabled&&settings.volume>0,grounded,flying,boosting,speed});mode=profile.mode;jetGain=profile.jet;
      if(!context||context.state!=='running'){jetGain=0;return;}
      const now=context.currentTime;
      master.gain.setTargetAtTime(profile.mode==='silent'?0:settings.volume*.65,now,.025);
      engineGain.gain.setTargetAtTime(profile.jet,now,.09);humGain.gain.setTargetAtTime(profile.jet*.14,now,.12);
      filter.frequency.setTargetAtTime(650+Math.min(80,speed)*25,now,.1);oscillator.frequency.setTargetAtTime(45+Math.min(80,speed)*.8,now,.1);
      if(profile.interval&&time/1000>=nextStep){footstep();nextStep=time/1000+profile.interval;}else if(!profile.interval)nextStep=0;
    },
    stop,
    getState:()=>({...settings,unlocked:Boolean(context),contextState:context?.state??'locked',steps,jetGain,mode}),
    dispose(){disposed=true;stop();eventTarget?.removeEventListener('pointerdown',gesture,{capture:true});eventTarget?.removeEventListener('keydown',gesture,{capture:true});eventTarget?.removeEventListener('blur',stop);noise?.stop();oscillator?.stop();void context?.close();}
  };
}
