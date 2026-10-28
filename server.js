'use strict';
const express=require('express'),http=require('http'),crypto=require('crypto');
const {Server}=require('socket.io');
const QR=require('qrcode');
const app=express(),server=http.createServer(app),io=new Server(server,{pingTimeout:25000});
const PORT=process.env.PORT||3000, ADMIN=process.env.ADMIN_PASSWORD;
if(!ADMIN||ADMIN.length<8){console.error('请先设置至少8位的 ADMIN_PASSWORD 环境变量');process.exit(1)}
app.use(express.static('public',{maxAge:'1h'}));
const defaults=['谁更容易生气？','谁更爱赖床？','谁先主动表白？','谁更会做饭？','谁更喜欢买东西？','谁更容易迷路？','谁更爱撒娇？','谁更可能忘记纪念日？','谁更擅长哄对方开心？','谁更喜欢拍照？'];
let game={phase:'lobby',round:0,index:0,questions:defaults,players:new Map(),answer:null,eliminated:[],winner:[]};
const validChoice=x=>x==='groom'||x==='bride';
const nameOf=x=>String(x||'').trim().replace(/[<>\u0000-\u001f]/g,'').slice(0,12);
function state(){return {phase:game.phase,round:game.round,index:game.index,question:game.questions[game.index]||'',total:game.questions.length,answer:game.phase==='revealed'?game.answer:null,eliminated:game.eliminated,winner:game.winner,players:[...game.players.values()].map(p=>({id:p.id,name:p.name,gender:p.gender,avatar:p.avatar,alive:p.alive,choice:p.choice,online:p.sockets.size>0}))};}
function emit(){io.emit('state',state())}
function ack(cb,obj){if(typeof cb==='function')cb(obj)}
function avatar(g){return (g==='female'?12:0)+Math.floor(Math.random()*12)}
app.get('/qr',async(req,res)=>{try{res.type('png').send(await QR.toBuffer(`${req.protocol}://${req.get('host')}/`,{width:280,margin:2}))}catch(e){res.status(500).send('二维码生成失败')}});
app.get('/health',(req,res)=>res.json({ok:true,players:game.players.size,phase:game.phase}));
app.get('/api/host-info',(req,res)=>res.json({passwordRequired:true}));
io.on('connection',s=>{
 s.emit('state',state());
 s.on('join',(data,cb)=>{
  let p=[...game.players.values()].find(x=>x.token===data?.token);
  if(!p){if(game.phase!=='lobby')return ack(cb,{ok:false,error:'游戏已开始，无法新加入'});
   if(game.players.size>=30)return ack(cb,{ok:false,error:'房间已满（30人）'});
   const name=nameOf(data?.name),gender=data?.gender;
   if(!name||!['male','female'].includes(gender))return ack(cb,{ok:false,error:'请填写名字并选择性别'});
   if([...game.players.values()].some(x=>x.name===name))return ack(cb,{ok:false,error:'这个名字已有人使用，请换一个昵称'});
   p={id:crypto.randomUUID(),token:crypto.randomBytes(24).toString('hex'),name,gender,avatar:avatar(gender),alive:true,choice:null,sockets:new Set()};game.players.set(p.id,p);
  }
  if(s.data.pid&&s.data.pid!==p.id){const old=game.players.get(s.data.pid);old?.sockets.delete(s.id)}
  s.data.pid=p.id;p.sockets.add(s.id);ack(cb,{ok:true,id:p.id,token:p.token});emit();
 });
 s.on('answer',(choice,cb)=>{const p=game.players.get(s.data.pid);if(!p||!p.alive||game.phase!=='question'||!validChoice(choice))return ack(cb,{ok:false,error:'现在不能选择'});p.choice=choice;ack(cb,{ok:true});emit()});
 s.on('host:login',(pwd,cb)=>{const a=Buffer.from(String(pwd||'')),b=Buffer.from(ADMIN);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return ack(cb,{ok:false,error:'主持密码错误'});s.data.host=true;ack(cb,{ok:true,questions:game.questions});});
 s.on('host:action',(d,cb)=>{
  if(!s.data.host)return ack(cb,{ok:false,error:'无权限'});
  const action=d?.action;
  if(action==='questions'){
   if(game.phase!=='lobby')return ack(cb,{ok:false,error:'只能在开始前编辑题目'});
   const qs=d.questions;if(!Array.isArray(qs)||qs.length<1||qs.length>40||qs.some(q=>!nameOf(q)||String(q).length>100))return ack(cb,{ok:false,error:'题目应为1至40条，每条不超过100字'});
   game.questions=qs.map(q=>String(q).trim());
  }else if(action==='start'){
   if(game.phase!=='lobby'||game.players.size===0)return ack(cb,{ok:false,error:'请在大厅等待玩家加入'});
   game.phase='question';game.index=0;game.round=1;game.answer=null;
  }else if(action==='reveal'){
   if(game.phase!=='question'||!validChoice(d.answer))return ack(cb,{ok:false,error:'请选择正确答案后公布'});
   game.answer=d.answer;game.eliminated=[];
   for(const p of game.players.values())if(p.alive&&p.choice!==d.answer){p.alive=false;game.eliminated.push(p.id)}
   game.phase='revealed';
  }else if(action==='next'){
   if(game.phase!=='revealed')return ack(cb,{ok:false,error:'请先公布答案'});
   if(game.index>=game.questions.length-1||![...game.players.values()].some(p=>p.alive)){
    game.phase='finished';game.winner=[...game.players.values()].filter(p=>p.alive).map(p=>p.id);
   }else{game.index++;game.round++;game.phase='question';game.answer=null;game.eliminated=[];for(const p of game.players.values())p.choice=null}
  }else if(action==='finish'){
   game.phase='finished';game.winner=[...game.players.values()].filter(p=>p.alive).map(p=>p.id);
  }else if(action==='reset'){
   game.phase='lobby';game.round=0;game.index=0;game.answer=null;game.eliminated=[];game.winner=[];
   for(const p of game.players.values()){p.alive=true;p.choice=null}
  }else if(action==='clear'){
   game.phase='lobby';game.round=0;game.index=0;game.answer=null;game.eliminated=[];game.winner=[];game.players.clear();
  }else return ack(cb,{ok:false,error:'未知操作'});
  ack(cb,{ok:true,questions:game.questions});emit();
 });
 s.on('disconnect',()=>{const p=game.players.get(s.data.pid);if(p){p.sockets.delete(s.id);emit()}});
});
server.listen(PORT,'0.0.0.0',()=>console.log('婚礼像素联机版已启动，端口 '+PORT));
