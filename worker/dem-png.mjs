import {decodeDemRgb} from '../src/terrain-height.js';

// Decode only the official DEM's 256x256 non-interlaced 8-bit RGB/RGBA format.
// No canvas, colour conversion, palette approximation or synthetic elevations.
export async function decodeDemPng(buffer) {
  const bytes=new Uint8Array(buffer),view=new DataView(buffer);
  if(bytes.length<45||[137,80,78,71,13,10,26,10].some((v,i)=>bytes[i]!==v))throw Error('Invalid DEM PNG');
  let channels=0,ended=false,offset=8;const chunks=[];
  while(offset+12<=bytes.length){
    const length=view.getUint32(offset),type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
    if(offset+12+length>bytes.length)throw Error('Truncated DEM PNG');
    const start=offset+8;
    if(type==='IHDR'){
      if(offset!==8||length!==13||view.getUint32(start)!==256||view.getUint32(start+4)!==256||bytes[start+8]!==8||
        ![2,6].includes(bytes[start+9])||bytes[start+10]!==0||bytes[start+11]!==0||bytes[start+12]!==0)throw Error('Unsupported DEM PNG');
      channels=bytes[start+9]===2?3:4;
    }else if(type==='IDAT')chunks.push(bytes.subarray(start,start+length));
    else if(type==='IEND'){ended=true;break;}
    else if(type==='tRNS'||type==='acTL')throw Error('Unsupported DEM transparency/animation');
    offset+=length+12;
  }
  if(!channels||!ended||!chunks.length)throw Error('Incomplete DEM PNG');
  const compressed=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));offset=0;
  for(const chunk of chunks){compressed.set(chunk,offset);offset+=chunk.length;}
  const stride=256*channels,expected=256*(stride+1),raw=new Uint8Array(expected);
  const reader=new Response(compressed).body.pipeThrough(new DecompressionStream('deflate')).getReader();offset=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;if(offset+value.length>expected)throw Error('DEM PNG inflate budget exceeded');raw.set(value,offset);offset+=value.length;}}
  finally{await reader.cancel();}
  if(offset!==expected)throw Error('Invalid DEM PNG pixels');
  const pixels=new Uint8Array(stride*256),heights=new Float64Array(65536);
  for(let y=0;y<256;y++){
    const filter=raw[y*(stride+1)];if(filter>4)throw Error('Invalid DEM PNG filter');
    for(let x=0;x<stride;x++){
      const i=y*stride+x,a=x>=channels?pixels[i-channels]:0,b=y?pixels[i-stride]:0,c=y&&x>=channels?pixels[i-stride-channels]:0;
      const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
      const predictor=[0,a,b,Math.floor((a+b)/2),pa<=pb&&pa<=pc?a:pb<=pc?b:c][filter];
      pixels[i]=(raw[y*(stride+1)+1+x]+predictor)&255;
    }
    for(let x=0;x<256;x++){
      const i=y*stride+x*channels,h=decodeDemRgb(pixels[i],pixels[i+1],pixels[i+2],channels===4?pixels[i+3]:255);
      heights[y*256+x]=h??NaN;
    }
  }
  return heights;
}
