// Run through the owning browser against the real static-asset server or public
// /manual. The script never signs in, changes a world or writes the OS clipboard.
(async()=>{
  const results=[];
  const check=(ok,name,detail)=>{results.push({ok:Boolean(ok),name,detail});if(!ok)throw Error(name);};
  const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  check(document.title.includes('先生・生徒の操作マニュアル'),'manual-document-not-3D-fallback');
  check(!document.querySelector('#login-gate,canvas'),'manual-readable-without-login-or-WebGL');
  check(document.documentElement.scrollWidth<=innerWidth+1,'no-horizontal-overflow',{width:innerWidth,scrollWidth:document.documentElement.scrollWidth});
  for(const id of ['teacher','student','pc','stl','quest','mobile','trouble','lesson']) {
    const section=document.getElementById(id);check(section?.textContent.length>150,'substantial-section-'+id);
    check(section.getBoundingClientRect().width<=innerWidth,'section-fits-'+id);
  }
  const previousBehavior=document.documentElement.style.scrollBehavior;
  document.documentElement.style.scrollBehavior='auto';
  for(const id of ['student','teacher']) {
    document.querySelector('.role-grid [href="#'+id+'"]').click();await frame();
    check(location.hash==='#'+id&&Math.abs(document.getElementById(id).getBoundingClientRect().top)<160,'role-jump-'+id);
  }
  document.documentElement.style.scrollBehavior=previousBehavior;
  const details=[...document.querySelectorAll('details')],before=details.map(node=>node.open);
  details[0].open=true;const expected=details.map(node=>node.open);
  window.dispatchEvent(new Event('beforeprint'));
  check(details.every(node=>node.open),'print-includes-closed-troubleshooting');
  window.dispatchEvent(new Event('afterprint'));
  check(details.every((node,i)=>node.open===expected[i]),'print-restores-disclosures');
  details.forEach((node,i)=>node.open=before[i]);
  let copied;
  try {
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{copied=value;}}});
    document.querySelector('#copy-class-url').click();await frame();
    check(copied==='https://metaquest001.gigach.net/'&&document.querySelector('#copy-status').textContent.includes('コピーしました'),'copy-handler-uses-public-class-url');
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('simulated denied');}}});
    document.querySelector('#copy-class-url').click();await frame();
    check(document.querySelector('#copy-status').textContent.includes('選択してコピー'),'copy-denial-has-manual-fallback');
  } finally { delete navigator.clipboard; }
  const link=document.querySelector('.site-header .button');
  check(new URL(link.href).pathname==='/'&&link.getBoundingClientRect().width>=44,'app-return-link-visible-and-correct');
  check([...document.querySelectorAll('#lesson input[type=checkbox]')].length===7,'teacher-checklist-seven-items');
  check([...document.querySelectorAll('#print-manual,[data-print-manual]')].some(node=>getComputedStyle(node).display!=='none'&&node.getBoundingClientRect().width>0),'print-action-available-at-this-width');
  const report={passed:true,width:innerWidth,results};window.__manualReport=report;return JSON.stringify(report);
})();
