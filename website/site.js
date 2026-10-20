(() => {
  const dialog = document.getElementById('numby-join-dialog');
  const title = document.getElementById('numby-join-title');
  const prompt = document.getElementById('numby-join-prompt');
  const close = dialog.querySelector('[data-numby-close]');
  const copy = dialog.querySelector('[data-numby-copy]');
  const status = dialog.querySelector('[role="status"]');
  let opener, previousOverflow, previousGutter, previousBodyOverflow, version = 0, backdropStart = false;
  const root = document.documentElement;
  const trigger = '[data-open-setup]';
  function open(button) {
    if (dialog.open) return;
    opener = button;
    previousOverflow = root.style.overflow;
    previousGutter = root.style.scrollbarGutter;
    previousBodyOverflow = document.body.style.overflow;
    root.style.scrollbarGutter = 'stable';
    root.style.overflow = document.body.style.overflow = 'hidden';
    status.textContent = '';
    version++;
    dialog.showModal();
    title.focus({preventScroll:true});
  }
  document.addEventListener('click', event => {
    const button = event.target.closest(trigger);
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation(); open(button);
  }, true);
  document.addEventListener('keydown', event => {
    const button = event.target.closest(trigger);
    if (!button || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation(); open(button);
  }, true);
  document.addEventListener('auxclick', event => {
    if (event.target.closest(trigger)) {event.preventDefault(); event.stopImmediatePropagation();}
  }, true);
  if (location.hash === '#get-a-number') open(document.querySelector(trigger));
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => {event.preventDefault(); dialog.close();});
  dialog.addEventListener('close', () => {
    version++; backdropStart = false;
    root.style.overflow = previousOverflow;
    root.style.scrollbarGutter = previousGutter;
    document.body.style.overflow = previousBodyOverflow;
    (opener?.isConnected ? opener : document.querySelector(trigger))?.focus({preventScroll:true});
  });
  const outside = event => {
    const r = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom);
  };
  dialog.addEventListener('pointerdown', event => {backdropStart = event.isPrimary && event.button === 0 && outside(event);});
  dialog.addEventListener('pointerup', event => {if (backdropStart && outside(event)) dialog.close(); backdropStart = false;});
  dialog.addEventListener('pointercancel', () => {backdropStart = false;});
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const nodes = [...dialog.querySelectorAll('button,a[href]')].filter(n => !n.closest('[hidden]'));
    const first=nodes[0], last=nodes[nodes.length-1];
    if(event.shiftKey && (document.activeElement===first || !nodes.includes(document.activeElement))){event.preventDefault();last.focus();}
    else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
  });
  copy.addEventListener('click', async () => {
    const currentVersion = version;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(prompt.textContent);
      if (dialog.open && version === currentVersion) status.textContent = 'Copied. Paste it into your agent.';
    } catch {
      if (!dialog.open || version !== currentVersion) return;
      prompt.focus({preventScroll:true});
      const range = document.createRange(); range.selectNodeContents(prompt);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      status.textContent = 'Couldn’t copy automatically. The prompt is selected. Use your device’s Copy command.';
    }
  });
})();

(() => {
  const flap = document.querySelector('.agent-flap');
  if (!flap) return;
  const agents = [
    {name:'Muse', color:'#006ff1'},
    {name:'Grok Bot', color:'#171717'},
    {name:'Hermes', color:'#0000c2'},
    {name:'dot', color:'#a16a0b'},
  ];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let index = 0, timer, finish, paused = false;
  const toggle = document.querySelector('.motion-toggle');
  function rest() {
    clearTimeout(finish);
    flap.querySelectorAll(':scope > :not(.flap-width)').forEach(el => el.remove());
    const face = document.createElement('span');
    face.className = 'flap-face flap-rest';
    face.textContent = reduced.matches ? 'your agent' : agents[index].name;
    face.style.color = reduced.matches ? '#171717' : agents[index].color;
    flap.append(face);
  }
  function half(agent, position, motion='') {
    const face = document.createElement('span');
    face.className = `flap-half flap-${position} ${motion}`;
    face.style.color = agent.color;
    const label = document.createElement('span');
    label.textContent = agent.name;
    face.append(label); flap.append(face);
  }
  function schedule() {
    clearTimeout(timer); rest();
    if (toggle) toggle.hidden = reduced.matches;
    if (reduced.matches || document.hidden || paused) return;
    timer = setTimeout(() => {
      const old = agents[index]; index = (index + 1) % agents.length;
      flap.querySelector('.flap-rest').remove();
      half(agents[index], 'top'); half(old, 'bottom');
      half(old, 'top', 'flap-out'); half(agents[index], 'bottom', 'flap-in');
      finish = setTimeout(schedule, 650);
    }, 3000);
  }
  toggle?.addEventListener('click', () => {
    paused = !paused;
    toggle.textContent = paused ? 'Resume animation' : 'Pause animation';
    toggle.setAttribute('aria-label', toggle.textContent);
    toggle.setAttribute('aria-pressed', String(paused));
    schedule();
  });
  reduced.addEventListener('change', schedule);
  document.addEventListener('visibilitychange', schedule);
  schedule();
})();
