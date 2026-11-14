// One carriage travels along the reviewed provider's physical rail. Its resting positions
// represent receipts, not elapsed time. The camera projection matches the stage poster.
const handoffRelay = (() => {
  const rails = {claude: 2, codex: 1, agy: 0};
  const stops = {review: .02, submitting: .18, queued: .40, opening:.60, opened:.985, copied:.985, closed:.985, running: .76, complete: .985, delivered: .985};
  const transitions = new Map();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const duration = 480;
  const viewWidth = 736, viewHeight = 352;

  function progress(entry, now) {
    const t = Math.max(0, Math.min(1, (now - entry.at) / duration));
    return entry.from + (entry.to - entry.from) * t * (2 - t);
  }
  function event(id, phase, {restored = false} = {}) {
    if (!id || (!(phase in stops) && phase !== 'failed')) return;
    const old = transitions.get(id);
    if (old?.phase === phase) return;
    const now = performance.now();
    const previous = old ? progress(old, now) : stops.review;
    const next = stops[phase] ?? previous;
    transitions.delete(id);
    transitions.set(id, {phase, at: now, from: restored ? next : previous, to: next});
    if (transitions.size > 64) transitions.delete(transitions.keys().next().value);
  }

  // The illustration is a projection of the very same tube meshes used in Preferences.
  function project(u, lane) {
    const [x,y,z] = relayPoint(u, lane);
    const scale = (viewHeight / 2) / (1 - z / 6.8);
    return [viewWidth/2 + x * scale, viewHeight/2 - y * scale];
  }
  function markup(id, agent, phase) {
    if (!Object.hasOwn(rails, agent) || !id || (!(phase in stops) && phase !== 'failed')) return '';
    return '<tasktap-relay aria-hidden="true" data-capture="'+attr(id)+'" data-agent="'+attr(agent)+'" data-phase="'+attr(phase)+'">'+
      '<img src="assets/motion/relay/bed.jpg" alt=""><canvas width="736" height="352"></canvas></tasktap-relay>';
  }
  function forCapture(capture) {
    const session = capture && sess(capture.session);
    if (!session) return '';
    const phase = capture.receipt === 'Started' ? 'running' : capture.receipt?.toLowerCase();
    return markup(capture.id,session.agent,phase);
  }
  class Relay extends HTMLElement {
    static observedAttributes = ['data-phase'];
    attributeChangedCallback() { if (this.isConnected) this.refresh(); }
    connectedCallback() {
      this.visible = false;
      this.intersection = new IntersectionObserver(([entry]) => {
        this.visible = entry.isIntersecting;
        this.refresh();
      });
      this.intersection.observe(this);
      document.addEventListener('visibilitychange',this.refresh);
      document.addEventListener('close',this.refresh,true);
      reduce.addEventListener('change',this.refresh);
    }
    disconnectedCallback() {
      this.intersection.disconnect();
      document.removeEventListener('visibilitychange',this.refresh);
      document.removeEventListener('close',this.refresh,true);
      reduce.removeEventListener('change',this.refresh);
      cancelAnimationFrame(this.frame);
    }
    refresh = () => {
      cancelAnimationFrame(this.frame);
      if (!this.visible || document.hidden || !this.isConnected) return;
      const topDialog = Array.from(document.querySelectorAll('dialog[open]')).at(-1);
      if (topDialog && !topDialog.contains(this)) return;
      const {capture,agent,phase} = this.dataset;
      const entry = transitions.get(capture);
      const transition = entry?.phase === phase ? entry : null;
      const now = performance.now();
      const resting = stops[phase] ?? transition?.to ?? .18;
      const u = transition && !reduce.matches ? progress(transition, now) : resting;
      const canvas = this.querySelector('canvas');
      if (!canvas) return;
      const g = canvas.getContext('2d');
      if (!g) return;
      g.clearRect(0,0,viewWidth,viewHeight);
      const lane = rails[agent];
      const [x,y] = project(u,lane);
      const failed = phase === 'failed';
      // Align the carriage and two guide collars with the local bend. The center
      // lamp stays on the receipt coordinate as the assembly travels into its stop.
      const [aheadX,aheadY]=project(Math.min(1,u+.012),lane);
      g.save();
      g.translate(x,y);g.rotate(Math.atan2(aheadY-y,aheadX-x));
      const steel=g.createLinearGradient(0,-13,0,13);
      for(const [at,tint] of [[0,'#394349'],[.15,'#a5b9bf'],[.27,'#e4e9dc'],[.35,'#7b8a8e'],[.47,'#1d292f'],[.75,'#41545c'],[.89,'#bcb09a'],[1,'#374043']]){
        steel.addColorStop(at,tint);
      }
      g.fillStyle=steel;g.beginPath();g.roundRect(-22,-10,44,20,4);g.fill();
      for(const side of [-1,1]){
        g.fillStyle='#162329';g.fillRect(side*14-2,-10,4,20);
        g.fillStyle=steel;g.beginPath();g.roundRect(side*20-3,-13,6,26,2);g.fill();
      }
      g.restore();
      // A small warm pool sits on the chrome. The white hot spot stays sharp at notch size.
      const glow = g.createRadialGradient(x,y,2,x,y,27);
      glow.addColorStop(0,failed?'#ff6644ed':'#ffcd80e6');
      glow.addColorStop(.35,failed?'#e75a2b91':'#ffbd5080');
      glow.addColorStop(1,'#ffac4200');
      g.fillStyle = glow;
      g.fillRect(x-27,y-27,54,54);
      g.lineCap = 'round';
      for (const [weight,color] of [[7,failed?'#ec7146':'#f0ae58'],[2.5,'#fff6d8']]) {
        g.beginPath();
        for (let i=0;i<=12;i++) {
          const point = project(Math.max(0,u-.036+i*.003),lane);
          if (i===0) g.moveTo(...point); else g.lineTo(...point);
        }
        g.strokeStyle=color;g.lineWidth=weight;g.stroke();
      }
      g.beginPath();g.arc(x,y,4.5,0,2*Math.PI);g.fillStyle=failed?'#ffb294':'#fff9dc';g.fill();
      if (transition && !reduce.matches && now < transition.at+duration) {
        this.frame = requestAnimationFrame(this.refresh);
      }
    }
  }
  customElements.define('tasktap-relay',Relay);
  return {event,markup,forCapture};
})();
