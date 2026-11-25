import { measureFacades } from './facade-layout.js';

export const buildingPalette=['#eadccc','#d3cfc1','#e2c9b6','#cad4d7','#ded3b8','#d5d9cd','#c4bdaf','#d6c2b0'];

// Connected surfaces share a color, including split roof/wall vertices.
// Coordinates and indices are read only; original geometry remains unchanged.
export function buildingAttributes(positions, indices) {
  const count=positions.length/3,parent=Uint32Array.from({length:count},(_,i)=>i),seen=new Map(),welded=new Uint32Array(count);
  const find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
  for(let i=0;i<count;i++) {
    const key=`${Math.round(positions[i*3]*100)},${Math.round(positions[i*3+1]*100)},${Math.round(positions[i*3+2]*100)}`;
    const previous=seen.get(key);
    welded[i]=previous??i;
    if(previous!==undefined)join(i,previous);else seen.set(key,i);
  }
  if(indices)for(let i=0;i<indices.length;i+=3){join(indices[i],indices[i+1]);join(indices[i],indices[i+2]);}
  else for(let i=0;i<count;i+=3){join(i,i+1);join(i,i+2);}
  const centers=new Map();
  const columns=new Map();
  const columnKey=i=>`${find(i)}:${Math.round(positions[i*3]*100)},${Math.round(positions[i*3+2]*100)}`;
  for(let i=0;i<count;i++){
    const root=find(i),x=positions[i*3],y=positions[i*3+1],z=positions[i*3+2];
    parent[i]=root;
    const c=centers.get(root)??[0,0,0,Infinity,-Infinity,Infinity,-Infinity,Infinity,-Infinity];
    c[0]+=x;c[1]+=z;c[2]++;c[3]=Math.min(c[3],y);c[4]=Math.max(c[4],y);
    c[5]=Math.min(c[5],x);c[6]=Math.max(c[6],x);c[7]=Math.min(c[7],z);c[8]=Math.max(c[8],z);centers.set(root,c);
    const key=columnKey(i),column=columns.get(key)??[Infinity,-Infinity];column[0]=Math.min(column[0],y);column[1]=Math.max(column[1],y);columns.set(key,column);
  }
  const colors=new Map([...centers].map(([root,c])=>{const seed=Math.abs(Math.round(c[0]/c[2]*3)*73856093 ^ Math.round(c[1]/c[2]*3)*19349663);
    c[9]=seed;
    const hex=buildingPalette[seed%buildingPalette.length];return [root,[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16))];}));
  const colorsBytes=new Uint8Array(count*3),spans=new Float32Array(count*2);
  for(let i=0;i<count;i++){
    const root=find(i),component=centers.get(root),column=columns.get(columnKey(i));
    colorsBytes.set(colors.get(root),i*3);spans[i*2]=component[3];
    // Each vertical corner keeps its own roof height. A low wing must not use
    // the tallest tower's roof; roof-only vertices use the component fallback.
    spans[i*2+1]=column[1]-column[0]>.1?column[1]:component[4];
  }
  const facades=measureFacades(positions,indices,parent,welded,centers);
  return {colors:colorsBytes,spans,facades};
}
export function buildingColorBytes(positions,indices) {
  return buildingAttributes(positions,indices).colors;
}
export function prepareBuildingGeometry(sourceAttributes,sourceIndex) {
  const positions=sourceAttributes.position.array;
  const attributes=buildingAttributes(positions,sourceIndex),count=positions.length/3;
  const indices=sourceIndex&&new Uint32Array(sourceIndex),mapping=Array.from({length:count},(_,i)=>i);
  const surfaces=new Array(count),variants=new Map(),facadeIds=new Map();
  // Coplanar triangles share the same fitted rectangle. Edges between two
  // facades need their own copy of a vertex, retaining identical coordinates.
  for(let t=0;t<attributes.facades.length;t++) {
    const facade=attributes.facades[t]??null;
    if(facade&&!facadeIds.has(facade))facadeIds.set(facade,facadeIds.size+1);
    for(let k=0;k<3;k++) {
      const at=t*3+k,i=sourceIndex?sourceIndex[at]:at;
      if(surfaces[i]===undefined||surfaces[i]===facade){surfaces[i]=facade;continue;}
      const key=`${i}:${facadeIds.get(facade)??0}`;
      let target=variants.get(key);
      if(target===undefined){target=mapping.length;mapping.push(i);surfaces.push(facade);variants.set(key,target);}
      indices[at]=target;
    }
  }
  const split = mapping.length > count;
  const vertices = split ? Object.fromEntries(Object.entries(sourceAttributes).map(([name,{array,itemSize}]) => {
    // Copy the original coordinates and metadata at each split corner.
    const expanded = new array.constructor(mapping.length * itemSize);
    for (let i = 0; i < mapping.length; i++) for (let component = 0; component < itemSize; component++) {
      expanded[i * itemSize + component] = array[mapping[i] * itemSize + component];
    }
    return [name, expanded];
  })) : null;
  const colors=new Uint8Array(mapping.length*3),spans=new Float32Array(mapping.length*2),design=new Float32Array(mapping.length*4);
  mapping.forEach((source,i)=>{
    colors.set(attributes.colors.subarray(source*3,source*3+3),i*3);
    const facade=surfaces[i];
    spans[i*2]=facade?.base??attributes.spans[source*2];
    spans[i*2+1]=facade?.top??attributes.spans[source*2+1];
    if(facade){
      const [dx,dz]=facade.axis;
      design.set([positions[source*3]*dx+positions[source*3+2]*dz-facade.left,
        facade.width,facade.type,Math.atan2(dz,dx)],i*4);
    }
  });
  return {vertices, indices: split ? indices : null, colors, spans, design};
}
