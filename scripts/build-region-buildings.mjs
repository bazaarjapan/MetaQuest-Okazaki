import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import draco3d from "draco3d";
import { ecefToWorld, lonLatToWorld, worldToLonLat, withinCore } from "./lib/region-geo.mjs";

// Original official artifacts stay in a recoverable cache. Only geometry (no
// CityGML/batch attributes) is published. The existing station import is untouched.
const base = "https://assets.cms.plateau.reearth.io/assets/eb/9515ec-6b7d-4acc-a511-022979da7661/23202_okazaki-shi_city_2020_citygml_8_op_files_bldg_3dtiles_lod1";
const sourceUrl = `${base}/tileset.json`, zipUrl = `${base}.zip`;
const cache = new URL("../.cache/region/", import.meta.url);
const output = new URL("../public/region/", import.meta.url);
const CELL = 500, MAX_TRIANGLES = 100000, GEOID_STEP = 4000;
const geoidApi = "https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh2011/cgi/geoidcalc.pl";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });

async function fetchBytes(url, expectedBytes) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(240000) });
      if (!response.ok) throw Error(`HTTP ${response.status}: ${url}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (expectedBytes && bytes.length !== expectedBytes) throw Error(`Length mismatch: ${bytes.length}`);
      return bytes;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}
async function cachedBytes(name, url, expectedBytes) {
  const target = new URL(name, cache);
  try {
    const bytes = await readFile(target);
    if (!expectedBytes || bytes.length === expectedBytes) return bytes;
  } catch { /* First import. */ }
  console.log(`Downloading ${name}`);
  const bytes = await fetchBytes(url, expectedBytes);
  const partial = new URL(`${name}.partial`, cache);
  await writeFile(partial, bytes);
  await rename(partial, target);
  return bytes;
}
const source = JSON.parse(new TextDecoder().decode(await cachedBytes("buildings-tileset.json", sourceUrl)));
const leaves = [];
function walk(tile) {
  if (tile.transform) throw Error("Unexpected tileset transform; must explicitly support it before importing.");
  if (tile.children?.length) tile.children.forEach(walk);
  else if (tile.content) leaves.push({ file: (tile.content.uri ?? tile.content.url).split("/").at(-1), region: tile.boundingVolume.region });
}
walk(source.root);
if (leaves.length !== 454) throw Error(`Unexpected official leaf count: ${leaves.length}; review upstream changes.`);
const geographicBounds = source.root.boundingVolume.region.slice(0, 4).map(v => v * 180 / Math.PI);
const corners = [[0,1], [2,1], [0,3], [2,3]].map(([a,b]) => lonLatToWorld(geographicBounds[a], geographicBounds[b]));
const coverage = [Math.min(...corners.map(p=>p[0])), Math.min(...corners.map(p=>p[2])), Math.max(...corners.map(p=>p[0])), Math.max(...corners.map(p=>p[2]))];

// GSI explicitly limits this API to 10 requests per 10 seconds per IP. Grid
// requests are serialized with 1.2 s spacing, cached and never made at runtime.
const geoidPath = new URL("geoid-2011.json", cache);
let geoid;
try { geoid = JSON.parse(await readFile(geoidPath, "utf8")); } catch { /* First import. */ }
const x0 = Math.floor(coverage[0] / GEOID_STEP) * GEOID_STEP;
const z0 = Math.floor(coverage[1] / GEOID_STEP) * GEOID_STEP;
const cols = Math.ceil((coverage[2] - x0) / GEOID_STEP) + 1;
const rows = Math.ceil((coverage[3] - z0) / GEOID_STEP) + 1;
if (!geoid || geoid.x0 !== x0 || geoid.z0 !== z0 || geoid.cols !== cols || geoid.rows !== rows) {
  geoid = { model: "GSIGEO2011", api: geoidApi, x0, z0, step: GEOID_STEP, cols, rows, points: [] };
}
for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
  const index = row * cols + col;
  if (geoid.points[index]) continue;
  const [lon, lat] = worldToLonLat(x0 + col * GEOID_STEP, z0 + row * GEOID_STEP);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const url = `${geoidApi}?outputType=json&latitude=${lat.toFixed(9)}&longitude=${lon.toFixed(9)}`;
  const data = JSON.parse(new TextDecoder().decode(await fetchBytes(url)));
  const height = Number(data.OutputData?.geoidHeight);
  if (!Number.isFinite(height) || height < 20 || height > 60) throw Error(`Invalid official geoid response: ${JSON.stringify(data)}`);
  geoid.points[index] = { lon, lat, height };
  await writeFile(geoidPath, JSON.stringify(geoid, null, 2));
  if ((index+1) % 10 === 0) console.log(`GSIGEO2011 grid ${index+1}/${cols*rows}`);
}
function geoidHeight(x, z) {
  const cx = Math.max(0, Math.min(cols-1.000001, (x-x0)/GEOID_STEP));
  const rz = Math.max(0, Math.min(rows-1.000001, (z-z0)/GEOID_STEP));
  const c = Math.floor(cx), r = Math.floor(rz), fx = cx-c, fz = rz-r;
  const h = (rr, cc) => geoid.points[rr*cols+cc].height;
  return (h(r,c)*(1-fx)+h(r,c+1)*fx)*(1-fz)+(h(r+1,c)*(1-fx)+h(r+1,c+1)*fx)*fz;
}

const zip = await cachedBytes("buildings-lod1.zip", zipUrl, 107388531);
const wanted = new Set(leaves.map(leaf=>leaf.file));
console.log(`Decompressing ${leaves.length} official leaf meshes`);
const files = unzipSync(zip, { filter: entry => wanted.has(entry.name.split("/").at(-1)) });
const byName = new Map(Object.entries(files).map(([name,bytes])=>[name.split("/").at(-1),bytes]));
if (byName.size !== leaves.length) throw Error(`ZIP is missing leaf files: ${byName.size}/${leaves.length}`);
const decoderModule = await draco3d.createDecoderModule({});
const buckets = new Map(), calibration = [];
const sourceBuildingIds = new Set(), excludedBuildingIds = new Set();
let totalTriangles = 0, sourceTriangles = 0, coreExcludedTriangles = 0, coreExcludedBuildings = 0;
let sourceBuildings = 0;
// Closest leaf first gives a useful early station-coordinate validation.
leaves.sort((a,b) => {
  const center=t=>lonLatToWorld((t.region[0]+t.region[2])*90/Math.PI,(t.region[1]+t.region[3])*90/Math.PI);
  const ca=center(a), cb=center(b);return Math.hypot(ca[0],ca[2])-Math.hypot(cb[0],cb[2]);
});

for (let leafIndex=0; leafIndex<leaves.length; leafIndex++) {
  const leaf=leaves[leafIndex], raw=byName.get(leaf.file);
  const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
  if (new TextDecoder().decode(raw.subarray(0,4))!=="b3dm" || view.getUint32(4,true)!==1 || view.getUint32(8,true)!==raw.length) throw Error(`Invalid B3DM: ${leaf.file}`);
  const ftLength=view.getUint32(12,true), ftBinLength=view.getUint32(16,true), btLength=view.getUint32(20,true), btBinLength=view.getUint32(24,true);
  const btOffset=28+ftLength+ftBinLength;
  const batch=JSON.parse(new TextDecoder().decode(raw.subarray(btOffset,btOffset+btLength)));
  const glbOffset=btOffset+btLength+btBinLength, jsonLength=view.getUint32(glbOffset+12,true);
  const gltf=JSON.parse(new TextDecoder().decode(raw.subarray(glbOffset+20,glbOffset+20+jsonLength)));
  const rtc=gltf.extensions?.CESIUM_RTC?.center;
  if (!rtc || gltf.nodes.some(node=>node.matrix||node.translation||node.rotation||node.scale)) throw Error(`Unsupported RTC/node transform: ${leaf.file}`);
  const binaryStart=glbOffset+20+jsonLength+8;
  for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
    if (primitive.mode!==undefined && primitive.mode!==4) throw Error("Nontriangle source primitive");
    if (gltf.images?.length) throw Error("Unexpected LOD1 texture; source needs explicit texture importer");
    const extension=primitive.extensions?.KHR_draco_mesh_compression;
    if (!extension) throw Error(`Missing Draco geometry: ${leaf.file}`);
    const bufferView=gltf.bufferViews[extension.bufferView];
    const compressed=raw.subarray(binaryStart+(bufferView.byteOffset??0),binaryStart+(bufferView.byteOffset??0)+bufferView.byteLength);
    const decoder=new decoderModule.Decoder(), decoderBuffer=new decoderModule.DecoderBuffer(), decoded=new decoderModule.Mesh();
    const positionValues=new decoderModule.DracoFloat32Array(), batchValues=new decoderModule.DracoFloat32Array(), face=new decoderModule.DracoInt32Array();
    try {
      decoderBuffer.Init(compressed,compressed.length);
      const status=decoder.DecodeBufferToMesh(decoderBuffer,decoded);
      if (!status.ok()) throw Error(status.error_msg());
      decoder.GetAttributeFloatForAllPoints(decoded,decoder.GetAttributeByUniqueId(decoded,extension.attributes.POSITION),positionValues);
      decoder.GetAttributeFloatForAllPoints(decoded,decoder.GetAttributeByUniqueId(decoded,extension.attributes._BATCHID),batchValues);
      const points=decoded.num_points(), positions=new Float64Array(points*3), buildingCenters=new Map();
      const minBuildingHeight=new Map();
      for(let index=0;index<points;index++) {
        const p=ecefToWorld(positionValues.GetValue(index*3)+rtc[0],-positionValues.GetValue(index*3+2)+rtc[1],positionValues.GetValue(index*3+1)+rtc[2]);
        p[1]-=geoidHeight(p[0],p[2]);
        if(!p.every(Number.isFinite)||p[1]<-100||p[1]>1500)throw Error(`Invalid projected vertex in ${leaf.file}`);
        positions.set(p,index*3);
        const batchId=Math.round(batchValues.GetValue(index)), center=buildingCenters.get(batchId)??[0,0,0];
        center[0]+=p[0];center[1]+=p[2];center[2]++;buildingCenters.set(batchId,center);
        minBuildingHeight.set(batchId,Math.min(minBuildingHeight.get(batchId)??Infinity,p[1]));
      }
      const excluded=new Set();
      for(const [id,c] of buildingCenters) {
        const sourceId=batch.gml_id[id]??`${leaf.file}:${id}`;
        sourceBuildingIds.add(sourceId);
        if(withinCore(c[0]/c[2],c[1]/c[2])){excluded.add(id);excludedBuildingIds.add(sourceId);}
      }
      coreExcludedBuildings+=excluded.size;sourceBuildings+=buildingCenters.size;
      // The official batch _zmin is original orthometric CityGML height. Check
      // against it; station models would float ~39 m without geoid correction.
      if(leafIndex===0&&batch._zmin?.componentType==="DOUBLE") {
        for(const [id,height] of [...minBuildingHeight].slice(0,12)) {
          const original=view.getFloat64(btOffset+btLength+batch._zmin.byteOffset+id*8,true);
          calibration.push({gmlId:batch.gml_id[id],originalHeight:original,convertedHeight:height,errorMeters:height-original});
        }
        const maxError=Math.max(...calibration.map(c=>Math.abs(c.errorMeters)));
        if(maxError>.2)throw Error(`Height calibration failed: ${maxError} m; review geoid model.`);
        console.log(`Station geoid calibration maximum error ${maxError.toFixed(4)} m`);
      }
      const fragments=new Map();
      for(let triangle=0;triangle<decoded.num_faces();triangle++) {
        sourceTriangles++;
        decoder.GetFaceFromMesh(decoded,triangle,face);
        const ids=[face.GetValue(0),face.GetValue(1),face.GetValue(2)];
        const building=Math.round(batchValues.GetValue(ids[0]));
        if(excluded.has(building)){coreExcludedTriangles++;continue;}
        const vertices=ids.map(id=>[positions[id*3],positions[id*3+1],positions[id*3+2]]);
        const centerX=vertices.reduce((a,p)=>a+p[0],0)/3, centerZ=vertices.reduce((a,p)=>a+p[2],0)/3;
        const key=`${Math.floor(centerX/CELL)},${Math.floor(centerZ/CELL)}`;
        const fragment=fragments.get(key)??{positions:[],normals:[]};
        const a=vertices[0],b=vertices[1],c=vertices[2],u=b.map((v,i)=>v-a[i]),v=c.map((q,i)=>q-a[i]);
        const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...n);
        if(length<1e-8)continue;
        for(const p of vertices){fragment.positions.push(...p);fragment.normals.push(n[0]/length,n[1]/length,n[2]/length);}
        fragments.set(key,fragment);totalTriangles++;
      }
      for(const [key,fragment] of fragments){const list=buckets.get(key)??[];list.push({positions:Float32Array.from(fragment.positions),normals:Float32Array.from(fragment.normals)});buckets.set(key,list);}
    } finally {
      for(const item of [face,batchValues,positionValues,decoded,decoderBuffer,decoder])decoderModule.destroy(item);
    }
  }
  byName.delete(leaf.file);
  // Removing the named decompressed entry allows GC during long conversions.
  for(const name of Object.keys(files))if(name.split("/").at(-1)===leaf.file)delete files[name];
  if((leafIndex+1)%25===0||leafIndex===0)console.log(`Decoded leaves ${leafIndex+1}/${leaves.length}; triangles=${totalTriangles}; cells=${buckets.size}`);
}

const tiles=[];
for(const [key,fragments] of buckets) {
  const [cellX,cellZ]=key.split(",").map(Number);
  let positions=[],normals=[],count=0,partition=0;
  async function flush() {
    if(!count)return;
    const id=`b-${cellX}-${cellZ}${partition?`-${partition}`:""}`, file=`${id}.bin`, rawVertices=count*3,vertices=rawVertices,indices=vertices;
    const binary=Buffer.alloc(vertices*32+indices*4),p=new Float32Array(binary.buffer,binary.byteOffset,vertices*3),n=new Float32Array(binary.buffer,binary.byteOffset+vertices*12,vertices*3),ind=new Uint32Array(binary.buffer,binary.byteOffset+vertices*32,indices);
    let offset=0;for(const chunk of positions){p.set(chunk,offset);offset+=chunk.length;}
    offset=0;for(const chunk of normals){n.set(chunk,offset);offset+=chunk.length;}
    const bounds=[Infinity,Infinity,-Infinity,-Infinity],heights=[Infinity,-Infinity];
    for(let i=0;i<vertices;i++){ind[i]=i;bounds[0]=Math.min(bounds[0],p[i*3]);bounds[1]=Math.min(bounds[1],p[i*3+2]);bounds[2]=Math.max(bounds[2],p[i*3]);bounds[3]=Math.max(bounds[3],p[i*3+2]);heights[0]=Math.min(heights[0],p[i*3+1]);heights[1]=Math.max(heights[1],p[i*3+1]);}
    const origin=[(bounds[0]+bounds[2])/2,(heights[0]+heights[1])/2,(bounds[1]+bounds[3])/2];
    let maxAbs=0;
    for(let i=0;i<vertices;i++)for(let axis=0;axis<3;axis++)maxAbs=Math.max(maxAbs,Math.abs(p[i*3+axis]-origin[axis]));
    const scale=Math.max(.02,maxAbs/32760),welded=new Map(),quantizedPositions=[],quantizedNormals=[],packedIndices=new Uint32Array(indices);
    let maxQuantizationErrorMeters=0;
    for(let index=0;index<vertices;index++) {
      const qp=[0,1,2].map(axis=>Math.round((p[index*3+axis]-origin[axis])/scale));
      const qn=[0,1,2].map(axis=>Math.round(Math.max(-1,Math.min(1,n[index*3+axis]))*127));
      for(let axis=0;axis<3;axis++)maxQuantizationErrorMeters=Math.max(maxQuantizationErrorMeters,Math.abs(qp[axis]*scale+origin[axis]-p[index*3+axis]));
      const key=[...qp,...qn].join(",");
      let weldedIndex=welded.get(key);
      if(weldedIndex===undefined) {
        weldedIndex=quantizedPositions.length/3;welded.set(key,weldedIndex);
        quantizedPositions.push(...qp);quantizedNormals.push(...qn);
      }
      packedIndices[index]=weldedIndex;
    }
    const packedVertices=quantizedPositions.length/3;
    const indexOffset=Math.ceil(packedVertices*9/4)*4,packed=Buffer.alloc(indexOffset+indices*4);
    new Int16Array(packed.buffer,packed.byteOffset,packedVertices*3).set(quantizedPositions);
    new Int8Array(packed.buffer,packed.byteOffset+packedVertices*6,packedVertices*3).set(quantizedNormals);
    new Uint32Array(packed.buffer,packed.byteOffset+indexOffset,indices).set(packedIndices);
    if(maxQuantizationErrorMeters>scale/2+1e-7)throw Error(`Quantization error exceeded theoretical bound: ${id}`);
    await writeFile(new URL(file,output),packed);
    tiles.push({id,type:"building",file,format:"region-building-v1",vertices:packedVertices,rawVertices,indices,triangles:count,origin,scale,indexOffset,maxQuantizationErrorMeters,bytes:packed.length,bounds,sha256:sha(packed),heightRange:heights});
    positions=[];normals=[];count=0;partition++;
  }
  for(const fragment of fragments)for(let start=0;start<fragment.positions.length;) {
    const remaining=MAX_TRIANGLES-count,triangleCount=Math.min(remaining,(fragment.positions.length-start)/9);
    positions.push(fragment.positions.subarray(start,start+triangleCount*9));normals.push(fragment.normals.subarray(start,start+triangleCount*9));count+=triangleCount;start+=triangleCount*9;
    if(count===MAX_TRIANGLES)await flush();
  }
  await flush();buckets.delete(key);
}
tiles.sort((a,b)=>a.id.localeCompare(b.id));
const bounds=[Math.min(...tiles.map(t=>t.bounds[0])),Math.min(...tiles.map(t=>t.bounds[1])),Math.max(...tiles.map(t=>t.bounds[2])),Math.max(...tiles.map(t=>t.bounds[3]))];
const manifest={version:"1.0.0",source:"国土交通省 PLATEAU 岡崎市 2020年度 建築物LOD1",sourceUrl,sourceZipUrl:zipUrl,sourceZipSha256:sha(zip),year:2020,bounds,geographicBounds,sourceTiles:leaves.length,sourceBuildings,sourceUniqueBuildings:sourceBuildingIds.size,sourceTriangles,totalTriangles,coreExcluded:{buildings:coreExcludedBuildings,uniqueBuildings:excludedBuildingIds.size,triangles:coreExcludedTriangles,method:"Original six-quarter-mesh rectangle; building centroid exclusion"},gridMeters:CELL,maxTileTriangles:MAX_TRIANGLES,geometryFormat:"region-building-v1: positions Int16 XYZ then normals normalized Int8 XYZ then pad to 4 byte alignment then indices Uint32; origin+scale; welded by quantized position and flat normal",maxQuantizationErrorMeters:Math.max(...tiles.map(t=>t.maxQuantizationErrorMeters)),uncompressedFloatBytes:totalTriangles*108,heightCorrection:{model:"GSIGEO2011",api:geoidApi,gridStepMeters:GEOID_STEP,samples:geoid.points.length,method:"Bilinear interpolation; ellipsoidal height minus geoid height = orthometric height",calibration},tiles};
if(tiles.reduce((sum,t)=>sum+t.triangles,0)!==totalTriangles)throw Error("Triangle accounting mismatch");
await writeFile(new URL("buildings.json",output),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({ok:true,sourceTiles:leaves.length,sourceBuildings,tiles:tiles.length,totalTriangles,bounds,bytes:tiles.reduce((a,t)=>a+t.bytes,0),manifestBytes:(await stat(new URL("buildings.json",output))).size,calibration},null,2));
