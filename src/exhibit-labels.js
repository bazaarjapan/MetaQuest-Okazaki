import * as THREE from "three";
import { exhibitTitle } from "./workshop-presentation.js";

export function exhibitLabelWidth(depth, projectionY, viewportHeight, maxPixels=220) {
  if (![depth,projectionY,viewportHeight,maxPixels].every(Number.isFinite) ||
      depth<=0 || projectionY<=0 || viewportHeight<=0 || maxPixels<=0) return 0;
  return Math.min(6,2*depth*maxPixels/(projectionY*viewportHeight));
}
export function exhibitDescriptionLines(value,characters=18,limit=4){
  const text=Array.from(typeof value==='string'?value.trim().replace(/\s+/g,' '):''),lines=[];
  for(let i=0;i<text.length&&lines.length<limit;i+=characters)lines.push(text.slice(i,i+characters).join(''));
  if(text.length>characters*limit)lines[limit-1]=Array.from(lines[limit-1]).slice(0,characters-1).join('')+'…';
  return lines;
}
// Only nearby exhibits need labels; textures are reused until their text changes.
export function createExhibitLabels(scene) {
  const labels=new Map();let last=-Infinity;
  const eye=new THREE.Vector3(),forward=new THREE.Vector3(),offset=new THREE.Vector3(),screen=new THREE.Vector3();
  let maxScreenWidth=0,expanded=0;
  const dispose=entry=>{entry.sprite.removeFromParent();entry.texture.dispose();entry.sprite.material.dispose();};
  return {
    update({objects,position,time,enabled=true,camera=null,viewportHeight=0,maxPixels=220}){
      if(time-last>=400 || !enabled){
      last=time;
      const nearby=enabled?objects.filter(o=>o.bounds&&Math.hypot(o.position[0]-position.x,o.position[2]-position.z)<100)
        .sort((a,b)=>Math.hypot(a.position[0]-position.x,a.position[2]-position.z)-Math.hypot(b.position[0]-position.x,b.position[2]-position.z)).slice(0,12):[];
      const ids=new Set(nearby.map(o=>o.id));
      const closest=nearby[0];
      for(const [id,entry] of labels)if(!ids.has(id)){dispose(entry);labels.delete(id);}
      for(const object of nearby){
        let entry=labels.get(object.id);
        if(!entry){
          const canvas=document.createElement("canvas");canvas.width=512;canvas.height=128;
          const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;
          const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthWrite:false,toneMapped:false}));
          sprite.scale.set(6,1.5,1);sprite.name="exhibit-label";scene.add(sprite);
          entry={canvas,texture,sprite,anchor:new THREE.Vector3(),key:""};labels.set(object.id,entry);
        }
        const title=exhibitTitle(object),author=object.authorName||"作品";
        const detailed=object.id===closest?.id&&Math.hypot(object.position[0]-position.x,object.position[2]-position.z)<18&&Boolean(object.description?.trim());
        const description=detailed?exhibitDescriptionLines(object.description):[];
        entry.detailed=detailed;
        entry.distance=Math.hypot(object.position[0]-position.x,object.position[2]-position.z);
        const key=title+"\n"+author+'\n'+description.join('\n');
        if(key!==entry.key){
          entry.key=key;const nextHeight=detailed?250:128,resizing=entry.canvas.height!==nextHeight;entry.canvas.height=nextHeight;
          if(resizing){entry.texture.dispose();entry.texture=new THREE.CanvasTexture(entry.canvas);entry.texture.colorSpace=THREE.SRGBColorSpace;entry.texture.generateMipmaps=false;entry.texture.minFilter=THREE.LinearFilter;entry.sprite.material.map=entry.texture;entry.sprite.material.needsUpdate=true;}
          const h=entry.canvas.height,ctx=entry.canvas.getContext("2d");ctx.clearRect(0,0,512,h);
          ctx.fillStyle="rgba(9,39,47,.95)";ctx.fillRect(0,0,512,h);
          ctx.fillStyle="#d0ebd6";ctx.fillRect(0,0,7,h);ctx.textAlign="center";
          ctx.font="bold 32px sans-serif";ctx.fillStyle="#fff";ctx.fillText(title,256,53,480);
          ctx.font="24px sans-serif";ctx.fillStyle="#b6dbcf";ctx.fillText('作者：'+author,256,96,480);
          if(detailed){ctx.textAlign='left';ctx.font='26px sans-serif';ctx.fillStyle='#f1f6eb';description.forEach((line,i)=>ctx.fillText(line,22,136+i*32,468));}
          entry.texture.needsUpdate=true;
        }
        entry.anchor.set((object.bounds.min[0]+object.bounds.max[0])/2,object.bounds.max[1]+1.3,(object.bounds.min[2]+object.bounds.max[2])/2);
      }
      }
      maxScreenWidth=0;expanded=0;
      if(camera){camera.getWorldPosition(eye);camera.getWorldDirection(forward);}
      for(const {sprite,canvas,detailed,distance,anchor} of labels.values()){
        sprite.position.copy(anchor);
        const depth=camera?offset.copy(sprite.position).sub(eye).dot(forward):0;
        const top=viewportHeight<500?70:140,bottom=viewportHeight<500?90:130;
        const heightLimit=Math.max(40,viewportHeight-top-bottom)*512/canvas.height;
        const width=camera?exhibitLabelWidth(depth,camera.projectionMatrix.elements[5],viewportHeight,Math.min(maxPixels,detailed?Math.min(300,heightLimit):220)):Math.min(6,Math.max(.8,distance*.5));
        sprite.visible=enabled&&width>0;sprite.scale.set(width,width*canvas.height/512,1);
        // A nearby information card must remain readable when its world anchor
        // sits above the camera. Keep its projected bounds inside the viewport.
        const overlay=Boolean(camera&&detailed);
        sprite.material.depthTest=!overlay;sprite.renderOrder=overlay?1000:0;
        if(camera&&detailed&&width>0){
          screen.copy(anchor).project(camera);
          const halfX=width*camera.projectionMatrix.elements[0]/(2*depth),halfY=sprite.scale.y*camera.projectionMatrix.elements[5]/(2*depth);
          screen.x=Math.max(-1+halfX+.04,Math.min(1-halfX-.04,screen.x));
          screen.y=Math.max(-1+halfY+2*bottom/viewportHeight,Math.min(1-halfY-2*top/viewportHeight,screen.y));
          sprite.position.copy(screen).unproject(camera);
        }
        if(sprite.visible&&detailed)expanded++;
        if(camera&&depth>0)maxScreenWidth=Math.max(maxScreenWidth,width*camera.projectionMatrix.elements[5]*viewportHeight/(2*depth));
      }
    },
    getState:()=>({count:labels.size,maxScreenWidth,expanded}),
    dispose(){for(const entry of labels.values())dispose(entry);labels.clear();}
  };
}
