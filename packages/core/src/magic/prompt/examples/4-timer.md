Request: pomodoro timer
Notes: nothing to look up; no source.

{"kind":"widget","title":"Pomodoro","size":"s"}
---
<div class="k-stack k-center k-fill">
  <div class="k-huge k-mono" id="clock">25:00</div>
  <div class="k-dim" id="phase">Focus</div>
  <div class="k-row"><button class="k-btn k-primary" id="go">Start</button><button class="k-btn" id="reset">Reset</button></div>
</div>
<script>
const LEN={Focus:25*60,Break:5*60};
let s=cmd.state.get("pomo")||{phase:"Focus",left:LEN.Focus,end:null};
const save=()=>cmd.state.set("pomo",s);
function tick(){
  if(s.end){s.left=Math.max(0,Math.round((s.end-Date.now())/1000));if(!s.left){s.phase=s.phase==="Focus"?"Break":"Focus";s.left=LEN[s.phase];s.end=null;save();}}
  clock.textContent=String(Math.floor(s.left/60)).padStart(2,"0")+":"+String(s.left%60).padStart(2,"0");
  phase.textContent=s.phase;go.textContent=s.end?"Pause":"Start";
}
go.onclick=()=>{s.end=s.end?null:Date.now()+s.left*1000;save();tick();};
reset.onclick=()=>{s={phase:"Focus",left:LEN.Focus,end:null};save();tick();};
setInterval(tick,500);tick();
</script>
