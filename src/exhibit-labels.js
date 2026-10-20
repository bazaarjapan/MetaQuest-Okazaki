import * as THREE from "three";
import { exhibitTitle } from "./workshop-presentation.js";

export function exhibitLabelWidth(depth, projectionY, viewportHeight, maxPixels=220) {
  if (![depth,projectionY,viewportHeight,maxPixels].every(Number.isFinite) ||
      depth<=0 || projectionY<=0 || viewportHeight<=0 || maxPixels<=0) return 0;
  return Math.min(6,2*depth*maxPixels/(projectionY*viewportHeight));
}
// Only nearby exhibits need labels; textures are reused until their text changes.
export function createExhibitLabels(scene) {
  const labels=new Map();let last=-Infinity;
  const eye=new THREE.Vector3(),forward=new THREE.Vector3(),offset=new THREE.Vector3();
  let maxScreenWidth=0;
  const dispose=entry=>{entry.sprite.removeFromParent();entry.texture.dispose();entry.sprite.material.dispose();};
  return {
    update({objects,position,time,enabled=true,camera=null,viewportHeight=0,maxPixels=220}){
      if(time-last>=400 || !enabled){
      last=time;
      const nearby=enabled?objects.filter(o=>o.bounds&&Math.hypot(o.position[0]-position.x,o.position[2]-position.z)<100)
        .sort((a,b)=>Math.hypot(a.position[0]-position.x,a.position[2]-position.z)-Math.hypot(b.position[0]-position.x,b.position[2]-position.z)).slice(0,12):[];
      const ids=new Set(nearby.map(o=>o.id));
      for(const [id,entry] of labels)if(!ids.has(id)){dispose(entry);labels.delete(id);}
      for(const object of nearby){
        let entry=labels.get(object.id);
        if(!entry){
          const canvas=document.createElement("canvas");canvas.width=512;canvas.height=128;
          const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;
          const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthWrite:false,toneMapped:false}));
          sprite.scale.set(6,1.5,1);sprite.name="exhibit-label";scene.add(sprite);
          entry={canvas,texture,sprite,key:""};labels.set(object.id,entry);
        }
        const title=exhibitTitle(object),author=object.authorName||"作品";
        const key=title+"\n"+author;
        if(key!==entry.key){
          entry.key=key;const ctx=entry.canvas.getContext("2d");ctx.clearRect(0,0,512,128);
          ctx.fillStyle="rgba(9,39,47,.92)";ctx.fillRect(0,0,512,128);
          ctx.fillStyle="#d0ebd6";ctx.fillRect(0,0,7,128);ctx.textAlign="center";
          ctx.font="bold 32px sans-serif";ctx.fillStyle="#fff";ctx.fillText(title,256,53,480);
          ctx.font="24px sans-serif";ctx.fillStyle="#b6dbcf";ctx.fillText(author,256,96,480);entry.texture.needsUpdate=true;
        }
        entry.sprite.position.set((object.bounds.min[0]+object.bounds.max[0])/2,object.bounds.max[1]+1.3,(object.bounds.min[2]+object.bounds.max[2])/2);
      }
      }
      maxScreenWidth=0;
      if(camera){camera.getWorldPosition(eye);camera.getWorldDirection(forward);}
      for(const {sprite} of labels.values()){
        const depth=camera?offset.copy(sprite.position).sub(eye).dot(forward):0;
        const width=camera?exhibitLabelWidth(depth,camera.projectionMatrix.elements[5],viewportHeight,maxPixels):6;
        sprite.visible=enabled&&width>0;sprite.scale.set(width,width/4,1);
        if(camera&&depth>0)maxScreenWidth=Math.max(maxScreenWidth,width*camera.projectionMatrix.elements[5]*viewportHeight/(2*depth));
      }
    },
    getState:()=>({count:labels.size,maxScreenWidth}),
    dispose(){for(const entry of labels.values())dispose(entry);labels.clear();}
  };
}
