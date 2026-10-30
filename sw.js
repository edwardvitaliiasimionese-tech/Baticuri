self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',()=>{});
self.addEventListener('push',e=>{
  let d={};
  try{d=e.data.json();}catch(x){d={title:'Baticuri',body:e.data?e.data.text():''};}
  e.waitUntil(self.registration.showNotification(d.title||'Baticuri',{body:d.body||'',icon:'/icon-192.png',badge:'/icon-192.png',tag:d.tag||undefined,data:{url:d.url||'/'}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const u=(e.notification.data&&e.notification.data.url)||'/';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(L=>{
    for(const c of L){if('focus' in c){if(c.navigate)c.navigate(u).catch(()=>{});return c.focus();}}
    return self.clients.openWindow(u);
  }));
});
