import { LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture } from 'three';

export const facadeAtlas = Object.freeze({file: 'facade-atlas.webp', bytes: 43904,
  sha256: 'd36e5087778d860634e750cc54ea289000eaec125cb0aa8a656eeb28a75a9711'});
export const neutralFacadeUniforms = {fieldFacadeAtlas: {value: null}, fieldFacadeReady: {value: 0}, fieldFacadeLite: {value: 0}};

export function createFacadeAtlas() {
  const uniforms = {fieldFacadeAtlas: {value: null}, fieldFacadeReady: {value: 0}, fieldFacadeLite: {value: 0}};
  let request;
  function load() {
    return request ??= (async () => {
      try {
        const response = await fetch(`/station/${facadeAtlas.file}?v=${facadeAtlas.sha256}`,
          {credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000)});
        if (!response.ok) throw Error('Facade atlas unavailable');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== facadeAtlas.bytes) throw Error('Facade atlas size mismatch');
        const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        if ([...sha].map(byte => byte.toString(16).padStart(2, '0')).join('') !== facadeAtlas.sha256)
          throw Error('Facade atlas hash mismatch');
        const image = await createImageBitmap(new Blob([bytes], {type: 'image/webp'}),
          {imageOrientation: 'flipY', colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
        if (image.width !== 1024 || image.height !== 512) { image.close(); throw Error('Invalid facade atlas dimensions'); }
        const texture = new Texture(image);
        texture.flipY = false; texture.colorSpace = SRGBColorSpace;
        texture.minFilter = LinearMipmapLinearFilter; texture.magFilter = LinearFilter; texture.anisotropy = 4;
        texture.needsUpdate = true;
        uniforms.fieldFacadeAtlas.value = texture;
        uniforms.fieldFacadeReady.value = 1;
        return true;
      } catch { request = null; return false; }
    })();
  }
  return { uniforms, load, setLightweight(value) { uniforms.fieldFacadeLite.value = value ? 1 : 0; } };
}

export const facadeDeclarations = `
  uniform sampler2D fieldFacadeAtlas;
  uniform float fieldFacadeReady;
  uniform float fieldFacadeLite;
  float facadeJoint(float point, float spacing, float pixel, float width) {
    float at = abs(fract(point / spacing + .5) - .5) * spacing;
    return (1.0-smoothstep(width,width+max(pixel,.002),at))*(1.0-smoothstep(.10,.30,pixel/spacing));
  }
`;

// Atlas slots left to right: living-room slider, casement, entry, storefront;
// balcony, office ribbon, roller shutter, clerestory. Marker sizes are metres.
export function facadeFragment(grounded) {
  return `
    float metres=distance(cameraPosition,vFieldPosition);
    vec3 facing=normalize(vFieldNormal);
    vec2 local=vec2(vFieldFacade.x,vFieldPosition.y-vFieldSpan.x);
    vec2 dx=dFdx(local),dy=dFdy(local),footprint=abs(dx)+abs(dy);
    float family=floor(vFieldFacade.z*.5+.01);
    bool front=mod(vFieldFacade.z,2.0)>.5;
    float wallHeight=max(vFieldSpan.y-vFieldSpan.x,.15);
    float headroom=vFieldSpan.y-vFieldPosition.y;
    float seed=fract(dot(vFieldColor,vec3(11.67,32.14,18.63)));
    float close=1.0-smoothstep(28.0,82.0,metres);
    float daylight=1.0-fieldEvening;
    vec3 paint=pow(vFieldColor,vec3(2.2));
    float roof=step(.48,abs(facing.y));
    float upness=clamp(local.y/wallHeight,0.0,1.0);
    paint*=mix(vec3(.78,.81,.83),vec3(1.05,1.03,1.02),upness);
    facadeRoughness=.87;
    if(roof>.5) {
      float pitched=smoothstep(.025,.28,1.0-abs(facing.y));
      vec3 sheet=mix(vec3(.21,.26,.29),vec3(.34,.31,.28),seed);
      vec3 ceramic=mix(vec3(.124,.170,.196),vec3(.36,.19,.127),smoothstep(.48,.88,seed));
      float seams=facadeJoint(vFieldPosition.x+vFieldPosition.z*.12,1.42,max(footprint.x,footprint.y),.012);
      paint=mix(sheet,ceramic,pitched*.90)*(1.0-seams*close*.13);
    } else {
      vec3 stone=mix(vec3(.32,.33,.30),paint*.78,.52);
      float plinth=(1.0-smoothstep(.32,.48,local.y));
      float trim=(1.0-smoothstep(.10,.25,headroom))*smoothstep(-.10,.025,headroom);
      paint=mix(paint,stone,plinth*.74);
      paint=mix(paint,paint*.7+vec3(.055,.062,.065),trim*.78);
      if (family>0.0 && close>0.0 && fieldFacadeLite<.5) {
        float joint=family>4.5 ? facadeJoint(local.x,.33,footprint.x,.014) :
          family>3.5 ? max(facadeJoint(local.x,1.5,footprint.x,.016),facadeJoint(local.y,1.2,footprint.y,.014)) :
          facadeJoint(local.y,family>2.5?.53:.24,footprint.y,.014);
        paint*=1.0-joint*close*(family>4.5?.27:.16);
      }
      float fade=1.0-smoothstep(mix(125.0,76.0,fieldFacadeLite),mix(210.0,135.0,fieldFacadeLite),metres);
      if(family>0.0 && fade>0.0 && fieldFacadeReady>.5) {
        float rise=family>4.5?3.0:family>3.5?3.65:family>2.5?3.05:family>1.5?3.26:2.76;
        float bay=family>4.5?3.55:family>3.5?2.72:family>2.5?2.7:family>1.5?3.0:2.55;
        if(!front&&family<=2.0) bay+=.28;
        float run=vFieldFacade.y-.76;
        float columns=max(1.0,floor(run/bay+.14));
        float stepX=run/columns;
        float column=clamp(floor((local.x-.38)/stepX),0.0,columns-1.0);
        float middle=.38+(column+.5)*stepX;
        float level=max(0.0,floor(local.y/rise));
        float opening=1.0, width=.83, height=1.09, sill=1.08;
        float choice=fract(seed*19.3+column*.618+level*.47);
        bool entry=front&&level<.5&&column==floor(columns*(seed>.50?.34:.67));
        if(family<1.5&&front) {
          opening=0.0;width=level<.5?1.79:1.60;height=level<.5?1.90:1.32;sill=level<.5?.49:.86;
        } else if(family<2.5&&family>1.5&&front) {
          opening=level<.5?3.0:0.0;width=level<.5?2.35:1.63;height=level<.5?2.42:1.31;sill=level<.5?.35:.94;
        } else if(family>2.5&&family<3.5&&front) {
          opening=level<.5?0.0:4.0;width=1.96;height=level<.5?1.36:1.87;sill=level<.5?.90:.68;
        } else if(family>3.5&&family<4.5) {
          opening=!front&&choice<.23?7.0:5.0;width=front?2.35:1.69;height=1.58;sill=1.07;
        } else if(family>4.5) {
          opening=entry?6.0:7.0;width=entry?2.64:1.22;height=entry?2.51:.65;sill=entry?.18:1.78;
        }
        if(entry&&family<3.5&&family!=2.0) { opening=2.0;width=1.20;height=2.24;sill=.14; }
        if(entry&&family>3.5&&family<4.5) { opening=3.0;width=2.3;height=2.68;sill=.19; }
        // A narrow wall or an uneven edge may not accommodate the complete module.
        // Never squeeze the glazing or let a partial opening cross the eaves.
        float bottom=level*rise+sill,top=bottom+height;
        float liftLimit=level<.5 ? max(0.0,min(rise-.11,wallHeight-.40)-top) : 0.0;
        float columnU=(local.x-middle)/width+.5;
        bool inLayout=width<=stepX-.13 && top+.40<=wallHeight && columnU>=0.0 && columnU<=1.0 &&
          local.y>=bottom && local.y<=top+liftLimit;
        if (family>4.5 && level>.5) inLayout=false;
        if (!front&&family<1.5&&columns>2.0&&choice<.34) inLayout=false;
        if(inLayout) {
          ${grounded?`vec2 tangent=vec2(cos(vFieldFacade.w),sin(vFieldFacade.w));
          vec2 anchor=vFieldPosition.xz+tangent*(middle-local.x)+vec2(tangent.y,-tangent.x)*.14;
          float floorY=vFieldSpan.x;
          float ground=max(cityHeight(anchor,floorY),max(cityHeight(anchor+tangent*width*.49,floorY),cityHeight(anchor-tangent*width*.49,floorY)));
          float lift=max(0.0,ground+.12-(floorY+bottom));
          inLayout=lift<=liftLimit;
          bottom+=lift;`:''}
          if(inLayout && local.y>=bottom && local.y<=bottom+height) {
            vec2 tile=vec2(mod(opening,4.0),1.0-floor(opening*.25));
            float mirror=choice>.47 ? -1.0 : 1.0;
            vec2 windowPos=vec2(.5+mirror*(columnU-.5),(local.y-bottom)/height);
            vec2 gradient=vec2(.25*mirror/width,.5/height),atlasScale=vec2(.25,.5);
            vec4 panel=textureGrad(fieldFacadeAtlas,(tile+windowPos)*atlasScale,dx*gradient,dy*gradient);
            panel.rgb*=mix(vec3(.88,.94,1.0),vec3(1.03,1.0,.95),choice);
            vec3 cool=vec3(.021,.045,.066);
            float glass=smoothstep(.009,.075,panel.b-panel.r);
            float reflected=(1.0-smoothstep(.08,.86,abs(dot(facing,normalize(cameraPosition-vFieldPosition)))))*glass;
            panel.rgb+=cool*reflected*daylight*close;
            paint=mix(paint,panel.rgb,panel.a*fade);
            facadeRoughness=mix(facadeRoughness,.31,glass*panel.a*fade);
            float occupied=step(.54,fract(choice*7.41));
            vec3 lit=mix(vec3(.96,.57,.25),vec3(.63,.79,.87),step(3.5,family));
            totalEmissiveRadiance+=lit*glass*panel.a*occupied*fade*fieldEvening*.59;
          }
        }
      }
    }
    diffuseColor.rgb=paint;
  `;
}
