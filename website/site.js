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
  const slot = document.querySelector('.agent-type');
  if (!slot) return;
  const content = slot.querySelector('.type-content');
  const text = slot.querySelector('.type-text');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const names = [
    {text:'Muse', color:'#006ff1'},
    {text:'Grok Bot', color:'#171717'},
    {text:'Hermes', color:'#0000c2'},
    {text:'dot', color:'#a16a0b'},
  ];
  let frame, stopped = false;
  const measure = () => { slot.style.width = `${content.getBoundingClientRect().width}px`; };
  function show(value, color) {
    text.textContent = value;
    slot.style.color = color;
    measure();
  }
  function stop() {
    stopped = true;
    cancelAnimationFrame(frame);
    slot.classList.remove('is-typing');
    show('your agent', '#006ff1');
  }
  // Any interaction permanently finishes the decorative intro without blocking the action.
  for (const event of ['keydown', 'pointerdown', 'touchstart', 'wheel']) {
    window.addEventListener(event, stop, {once:true, passive:true});
  }
  reduced.addEventListener('change', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('resize', measure);
  document.fonts.ready.then(() => {
    if (stopped || reduced.matches || document.hidden) { stop(); return; }
    // One deliberate pass, with time to read every complete name.
    // Interaction and reduced motion finish it immediately; it never restarts.
    const steps = [{at:0, ...names[0]}];
    let at = 0;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      at += 1800;
      for (let n = name.text.length - 1; n >= 0; n--) {
        at += 45; steps.push({at, text:name.text.slice(0,n), color:name.color});
      }
      const next = names[i + 1] || {text:'your agent', color:'#006ff1'};
      for (let n = 1; n <= next.text.length; n++) {
        at += 100; steps.push({at, text:next.text.slice(0,n), color:next.color});
      }
    }
    show(names[0].text, names[0].color);
    slot.classList.add('is-typing');
    const start = performance.now();
    let current = 0;
    function tick(now) {
      const elapsed = now - start;
      if (elapsed >= at + 100) { stop(); return; }
      let next = current;
      while (next + 1 < steps.length && steps[next + 1].at <= elapsed) next++;
      if (next !== current) { current = next; show(steps[current].text, steps[current].color); }
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
  });
})();
