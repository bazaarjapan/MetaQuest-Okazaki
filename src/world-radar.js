export function radarPoint(position, target, yaw, range, radius=76) {
  const dx=target[0]-position.x,dz=target[2]-position.z,distance=Math.hypot(dx,dz);
  // yaw=0 looks north (-Z). Rotate the map so heading remains at the top.
  const right=dx*Math.cos(yaw)-dz*Math.sin(yaw),forward=dx*Math.sin(yaw)+dz*Math.cos(yaw);
  const scale=radius/Math.max(range,distance);
  return {x:right*scale,y:forward*scale,distance,edge:distance>range};
}
export function createWorldRadar({parent,onOpenWorks=()=>{},onFocusWorld=()=>{}}) {
  const root=document.createElement("section");root.id="world-radar";root.setAttribute("aria-label","自分の作品レーダー");
  const heading=document.createElement("div");heading.className="radar-heading";heading.textContent="作品レーダー";
  const fold=document.createElement("button");fold.textContent="−";fold.setAttribute("aria-label","レーダーを折りたたむ");fold.setAttribute("aria-expanded","true");
  heading.append(fold);
  const body=document.createElement("div"),canvas=document.createElement("canvas");canvas.width=canvas.height=384;
  canvas.setAttribute("role","img");canvas.setAttribute("aria-label","中央が自分。金色の点が自分の作品、青色が駅。上は進行方向。");
  const controls=document.createElement("div");controls.className="radar-actions";
  const zoom=document.createElement("button"),works=document.createElement("button");works.textContent="作品一覧";
  works.onclick=onOpenWorks;
  const summary=document.createElement("p");summary.className="radar-summary";
  const ranges=[100,300,1000,5000];let index=1,last=-Infinity,folded=false,latest=null;
  zoom.textContent="半径 300 m";zoom.setAttribute("aria-label","レーダーの表示距離を変更");
  zoom.onclick=()=>{index=(index+1)%ranges.length;zoom.textContent=`半径 ${ranges[index].toLocaleString()} m`;last=-Infinity;onFocusWorld();};
  fold.onclick=()=>{folded=!folded;body.hidden=folded;fold.textContent=folded?"+":"−";fold.setAttribute("aria-expanded",String(!folded));fold.setAttribute("aria-label",folded?"レーダーを開く":"レーダーを折りたたむ");onFocusWorld();};
  controls.append(zoom,works);body.append(canvas,controls,summary);root.append(heading,body);parent.append(root);
  const ctx=canvas.getContext("2d");
  return {
    update({position,yaw,objects,userId,station,time,hidden=false}){
      root.hidden=hidden||!userId;if(root.hidden||folded||time-last<120)return;last=time;
      const own=objects.filter(o=>o.ownerId===userId),range=ranges[index];
      latest={range,count:own.length,heading:yaw,markers:own.map(o=>({id:o.id,...radarPoint(position,o.position,yaw,range)}))};
      ctx.setTransform(2,0,0,2,192,192);ctx.clearRect(-96,-96,192,192);
      const glow=ctx.createRadialGradient(0,0,0,0,0,88);glow.addColorStop(0,"#123f35");glow.addColorStop(1,"#082b28");
      ctx.fillStyle=glow;ctx.beginPath();ctx.arc(0,0,88,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle="#74d9a844";ctx.lineWidth=1;
      for(const r of [25,51,77,88]){ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.stroke();}
      ctx.beginPath();ctx.moveTo(-88,0);ctx.lineTo(88,0);ctx.moveTo(0,-88);ctx.lineTo(0,88);ctx.stroke();
      ctx.textAlign="center";ctx.textBaseline="middle";ctx.font="bold 11px sans-serif";
      for(const [label,angle] of [["N",0],["E",Math.PI/2],["S",Math.PI],["W",-Math.PI/2]]){
        ctx.fillStyle=label==="N"?"#bfffe2":"#81bba8";ctx.fillText(label,Math.sin(angle+yaw)*84,-Math.cos(angle+yaw)*84);
      }
      const dot=(p,color,label)=>{
        ctx.fillStyle=color;ctx.strokeStyle="#06221f";ctx.lineWidth=2;ctx.beginPath();
        if(p.edge){ctx.moveTo(p.x,p.y-6);ctx.lineTo(p.x+5,p.y);ctx.lineTo(p.x,p.y+6);ctx.lineTo(p.x-5,p.y);ctx.closePath();}
        else ctx.arc(p.x,p.y,5,0,Math.PI*2);
        ctx.fill();ctx.stroke();if(label){ctx.fillStyle="#dbffff";ctx.fillText(label,p.x,p.y-12);}
      };
      if(station)dot(radarPoint(position,station,yaw,range),"#70d6ff","駅");
      latest.markers.forEach(p=>dot(p,"#ffd769"));
      ctx.fillStyle="#effff8";ctx.beginPath();ctx.moveTo(0,-8);ctx.lineTo(6,7);ctx.lineTo(0,4);ctx.lineTo(-6,7);ctx.closePath();ctx.fill();
      const nearest=latest.markers.reduce((best,p)=>Math.min(best,p.distance),Infinity);
      summary.textContent=own.length?`自分の作品 ${own.length}点 · 最寄り ${Math.round(nearest).toLocaleString()} m`:"中央が自分 · 青は駅 · 上が進行方向";
      canvas.setAttribute("aria-label",`中央が自分、上が進行方向。半径${range}メートル。${summary.textContent}。金色が作品、青が駅、縁の菱形は範囲外。`);
    },
    getState:()=>latest,
    destroy:()=>root.remove()
  };
}
