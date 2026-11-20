/* Almacén de imágenes del sitio (se carga primero en todas las páginas).
   Problema que resuelve: el navegador solo deja guardar ~5 MB en localStorage. Las fotos y logos subidos en modo edición
   llenaban ese espacio y, cuando se llenaba, los cambios nuevos NO se guardaban (sin avisar).
   Solución: las imágenes grandes se guardan aparte, en IndexedDB (cientos de MB), y en localStorage solo queda una
   referencia corta. Es transparente para el resto de los scripts: siguen usando localStorage como siempre.
   - Migra automáticamente las imágenes que ya estaban guardadas en el formato antiguo.
   - Borra del almacén las imágenes que ya no usa ninguna página.
   Media.run(fn): ejecuta fn cuando el almacén está listo · Media.saved(cb): cb cuando terminó de guardar · Media.toast(texto, esError) */
(function(){
 'use strict';
 var KEYS=['inicio-v1','trabajo-v1','servicios-v1','plenario-v1','portada-v1','footer-v1'];
 var DB='regalia-media',ST='v',PFX='img:';
 /* Se recorre el texto con indexOf (no con una expresión regular): así funciona con GIF de decenas de MB. */
 var PREFIX=/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/;
 var REF=/idb:[a-z0-9]+-\d+/g;
 var mem={},stored={},db=null,ACTIVE=false,ready=false,waiters=[],pending=0,idle=[];
 var rawGet=Storage.prototype.getItem,rawSet=Storage.prototype.setItem;

 function toast(text,err){
  try{
   var t=document.createElement('div');t.className='mtoast'+(err?' err':'');t.setAttribute('role',err?'alert':'status');t.textContent=text;
   document.body.appendChild(t);setTimeout(function(){t.classList.add('out')},err?6000:3200);setTimeout(function(){t.remove()},err?6600:3800);
  }catch(e){}
 }
 function hash(s){
  var h1=0xdeadbeef,h2=0x41c6ce57,i,c;
  for(i=0;i<s.length;i++){c=s.charCodeAt(i);h1=Math.imul(h1^c,2654435761);h2=Math.imul(h2^c,1597334677)}
  h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
  h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
  return (4294967296*(2097151&h2)+(h1>>>0)).toString(36);
 }
 var queue={};
 function dehydrate(json){
  var out=[],pos=0,i,changed=false;
  while((i=json.indexOf('data:image/',pos))>-1){
   var end=json.indexOf('"',i);if(end<0)end=json.length;
   if(end-i>1500&&PREFIX.test(json.substr(i,40))){
    var url=json.slice(i,end),ref=hash(url)+'-'+url.length,key=PFX+ref;
    mem[key]=url;if(!stored[key])queue[key]=url;
    out.push(json.slice(pos,i),'idb:'+ref);pos=end;changed=true;
   } else {out.push(json.slice(pos,end));pos=end}
  }
  out.push(json.slice(pos));
  return changed?out.join(''):json;
 }
 function hasBig(json){
  var pos=0,i;
  while((i=json.indexOf('data:image/',pos))>-1){
   var end=json.indexOf('"',i);if(end<0)end=json.length;
   if(end-i>1500&&PREFIX.test(json.substr(i,40)))return true;
   pos=end;
  }
  return false;
 }
 function hydrate(json){
  return json.replace(REF,function(r){var u=mem[PFX+r.slice(4)];return u||r});
 }
 function done(){pending--;if(!pending){var w=idle.splice(0);w.forEach(function(f){f()})}}
 function flush(cb){
  var keys=Object.keys(queue);
  if(!keys.length||!db){if(cb)cb(true);return}
  var items=keys.map(function(k){return [k,queue[k]]});queue={};pending++;
  try{
   var tx=db.transaction(ST,'readwrite'),s=tx.objectStore(ST);
   items.forEach(function(it){s.put(it[1],it[0])});
   tx.oncomplete=function(){items.forEach(function(it){stored[it[0]]=1});done();if(cb)cb(true)};
   tx.onabort=tx.onerror=function(){done();toast('No se pudo guardar una imagen en este navegador (almacenamiento lleno o bloqueado). Prueba con imágenes más livianas.',true);if(cb)cb(false)};
  }catch(e){done();toast('No se pudo guardar una imagen en este navegador.',true);if(cb)cb(false)}
 }
 function install(){
  Storage.prototype.setItem=function(k,v){
   if(ACTIVE&&this===window.localStorage&&KEYS.indexOf(k)>-1&&typeof v==='string'){v=dehydrate(v);rawSet.call(this,k,v);flush();return}
   return rawSet.call(this,k,v);
  };
  Storage.prototype.getItem=function(k){
   var v=rawGet.call(this,k);
   if(ACTIVE&&this===window.localStorage&&KEYS.indexOf(k)>-1&&typeof v==='string')return hydrate(v);
   return v;
  };
 }
 function finish(on){
  ACTIVE=!!on;if(on)install();ready=true;
  waiters.splice(0).forEach(function(f){try{f()}catch(e){console.error(e)}});
  if(on)setTimeout(gc,2500);
 }
 /* imágenes que ninguna página usa → se borran del almacén */
 function gc(){
  try{
   var used={};
   KEYS.forEach(function(k){var v=rawGet.call(localStorage,k);if(v){(v.match(REF)||[]).forEach(function(r){used[PFX+r.slice(4)]=1})}});
   var dead=Object.keys(stored).filter(function(k){return !used[k]&&!queue[k]});
   if(!dead.length||pending)return;
   var tx=db.transaction(ST,'readwrite'),s=tx.objectStore(ST);
   dead.forEach(function(k){s.delete(k);delete stored[k];delete mem[k]});
  }catch(e){}
 }
 function init(){
  if(!window.indexedDB){finish(false);return}
  var guard=setTimeout(function(){if(!ready)finish(false)},3000);
  var q;
  try{q=indexedDB.open(DB,1)}catch(e){clearTimeout(guard);finish(false);return}
  q.onupgradeneeded=function(){if(!q.result.objectStoreNames.contains(ST))q.result.createObjectStore(ST)};
  q.onerror=q.onblocked=function(){clearTimeout(guard);if(!ready)finish(false)};
  q.onsuccess=function(){
   db=q.result;
   try{
    var tx=db.transaction(ST,'readonly'),cur=tx.objectStore(ST).openCursor(IDBKeyRange.bound(PFX,PFX+'\uffff'));
    cur.onsuccess=function(){var c=cur.result;if(c){mem[c.key]=c.value;stored[c.key]=1;c.continue()}};
    tx.oncomplete=function(){
     /* migración: imágenes que estaban dentro de localStorage (formato antiguo) */
     var rewrite={};
     KEYS.forEach(function(k){var v=rawGet.call(localStorage,k);if(v&&v.length>1500&&hasBig(v))rewrite[k]=dehydrate(v)});
     var ks=Object.keys(rewrite);
     clearTimeout(guard);
     if(!ks.length){finish(true);return}
     flush(function(ok){
      if(ok){ks.forEach(function(k){try{rawSet.call(localStorage,k,rewrite[k])}catch(e){}})}
      finish(ok);
     });
    };
    tx.onerror=tx.onabort=function(){clearTimeout(guard);if(!ready)finish(false)};
   }catch(e){clearTimeout(guard);finish(false)}
  };
 }
 window.Media={
  run:function(fn){if(ready)fn();else waiters.push(fn)},
  saved:function(cb){if(!pending)cb();else idle.push(cb)},
  toast:toast,
  get active(){return ACTIVE}
 };
 init();
})();
