/* Shared by the guide and both explorers. Run scripts/sync_feedback.py after edits. */
(() => {
  'use strict';
  if (document.getElementById('feedbackDialog')) return;
  const style = document.createElement('style');
  style.textContent = `
    #feedbackDialog { box-sizing:border-box; width:min(510px,calc(100% - 28px)); max-height:calc(100dvh - 28px); overflow:auto; margin:auto; padding:28px; color:#e4ece9; background:#101a1c; border:1px solid #384a49; border-radius:20px; box-shadow:0 24px 100px #000a; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color-scheme:dark; }
    #feedbackDialog *, #feedbackDialog *::before, #feedbackDialog *::after { box-sizing:border-box; }
    #feedbackDialog::backdrop { background:#020808ba; backdrop-filter:blur(5px); }
    #feedbackDialog [hidden] { display:none!important; }
    #feedbackDialog header { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin:0 0 24px; }
    #feedbackDialog h2 { font:600 27px/1.18 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:-.045em; margin:7px 0 0; max-width:310px; color:#eef4ef; }
    #feedbackDialog .fb-eyebrow { font:500 10px/1.5 ui-monospace,monospace; letter-spacing:.12em; text-transform:uppercase; color:#a5bbb3; }
    #feedbackDialog button { cursor:pointer; font:inherit; }
    #feedbackDialog .fb-close { flex:none; width:36px; height:36px; padding:0; background:transparent; border:1px solid #384a49; border-radius:50%; color:#b7c7c1; font-size:23px; line-height:1; }
    #feedbackDialog .fb-types { display:flex; gap:7px; border:0; padding:0; margin:0 0 20px; }
    #feedbackDialog legend { position:absolute; width:1px; height:1px; clip-path:inset(50%); overflow:hidden; }
    #feedbackDialog .fb-type { flex:1; position:relative; cursor:pointer; }
    #feedbackDialog .fb-type input { position:absolute; opacity:0; width:1px; height:1px; }
    #feedbackDialog .fb-type span { display:flex; align-items:center; justify-content:center; text-align:center; min-height:44px; padding:9px 6px; border:1px solid #384a49; border-radius:9px; color:#adbfba; font-size:13px; }
    #feedbackDialog .fb-type input:checked+span { background:#a8d6b312; border-color:#a8d6b3; color:#c5e9ce; }
    #feedbackDialog label.fb-label { display:block; color:#c5d2cc; font-size:13px; margin:17px 0 7px; }
    #feedbackDialog .fb-label small { font-size:12px; color:#93a79f; font-weight:400; }
    #feedbackDialog textarea, #feedbackDialog input[type=email] { display:block; width:100%; border:1px solid #384a49; border-radius:10px; background:#0a1214; color:#edf3ef; padding:12px; font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    #feedbackDialog textarea { min-height:136px; resize:vertical; }
    #feedbackDialog textarea::placeholder, #feedbackDialog input::placeholder { color:#81978e; opacity:1; }
    #feedbackDialog :is(button,input,textarea):focus-visible, #feedbackDialog .fb-type:has(:focus-visible) span { outline:2px solid #a8d6b3; outline-offset:3px; }
    #feedbackDialog .fb-note { color:#97aaa3; font-size:12px; margin:10px 0 0; }
    #feedbackDialog .fb-status { margin:14px 0 0; color:#f5b7a3; font-size:13px; }
    #feedbackDialog .fb-status:empty { display:none; }
    #feedbackDialog .fb-submit { width:100%; display:flex; align-items:center; justify-content:center; gap:10px; background:#a8d6b3; color:#12291b; border:0; border-radius:10px; padding:13px; margin-top:22px; font-weight:650; min-height:48px; }
    #feedbackDialog .fb-submit:hover { background:#c1e6ca; }
    #feedbackDialog .fb-submit:disabled { opacity:.6; cursor:wait; }
    #feedbackDialog .fb-success { padding:6px 0; }
    #feedbackDialog .fb-success p { color:#b7cac1; margin:14px 0 26px; }
    #feedbackDialog .fb-check { display:grid; place-items:center; width:48px; height:48px; border:1px solid #79a88a; border-radius:50%; color:#a8d6b3; font-size:24px; margin-bottom:20px; }
    #feedbackDialog .fb-trap { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
    .feedback-float { position:fixed; right:20px; bottom:20px; z-index:12; display:flex; align-items:center; gap:8px; background:#152322; color:#c7dfd0; border:1px solid #536e61; border-radius:30px; padding:10px 16px; font:500 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; cursor:pointer; box-shadow:0 4px 24px #0005; }
    .feedback-float:hover { background:#20362d; }
    .feedback-float svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.6; }
    @media(max-width:430px) { #feedbackDialog { padding:22px; } #feedbackDialog h2 { font-size:26px; } .feedback-float { right:14px; bottom:14px; } }
  `;
  document.head.append(style);
  const dialog = document.createElement('dialog');
  dialog.id = 'feedbackDialog';
  dialog.setAttribute('aria-labelledby', 'feedbackTitle');
  dialog.innerHTML = `
    <header><div><span class="fb-eyebrow">Bitcoin Timelapse / Feedback</span><h2 id="feedbackTitle">What would make this better?</h2></div><button type="button" class="fb-close" aria-label="Close feedback">×</button></header>
    <form id="feedbackForm">
      <fieldset class="fb-types"><legend>Feedback type</legend>
        <label class="fb-type"><input type="radio" name="category" value="idea" checked><span>Feature idea</span></label>
        <label class="fb-type"><input type="radio" name="category" value="bug"><span>Bug report</span></label>
        <label class="fb-type"><input type="radio" name="category" value="other"><span>Other</span></label>
      </fieldset>
      <label class="fb-label" for="feedbackMessage">Your feedback</label>
      <textarea id="feedbackMessage" name="message" rows="5" maxlength="4000" required placeholder="I'd love to be able to…" autofocus></textarea>
      <label class="fb-label" for="feedbackEmail">Email <small>— optional, if you'd like a reply</small></label>
      <input id="feedbackEmail" name="email" type="email" maxlength="254" autocomplete="email" placeholder="you@example.com">
      <label class="fb-trap" aria-hidden="true">Website<input name="website" type="text" tabindex="-1" autocomplete="off"></label>
      <p class="fb-note">Sent directly to the project's email. No account needed.</p>
      <p id="feedbackContext" class="fb-note" hidden></p>
      <p id="feedbackStatus" class="fb-status" role="status" aria-live="polite"></p>
      <button class="fb-submit" type="submit"><span id="feedbackSendLabel">Send feedback</span><span aria-hidden="true">↗</span></button>
    </form>
    <div class="fb-success" id="feedbackSuccess" hidden tabindex="-1"><span class="fb-check" aria-hidden="true">✓</span><h2 id="feedbackSuccessTitle">Thanks for the feedback.</h2><p>Your message has been sent. If you left an email, we can reply there.</p><button class="fb-submit" type="button" id="feedbackDone">Done</button></div>
  `;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const message = dialog.querySelector('#feedbackMessage');
  const status = dialog.querySelector('#feedbackStatus');
  const send = form.querySelector('[type=submit]');
  const sendLabel = dialog.querySelector('#feedbackSendLabel');
  const success = dialog.querySelector('#feedbackSuccess');
  const contextNote = dialog.querySelector('#feedbackContext');
  let view = null;
  let sending = false;
  let sent = false;
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-feedback]')) return;
    event.preventDefault();
    if (dialog.open) return;
    if (sent) {
      form.hidden = false;
      success.hidden = true;
      dialog.querySelector('header').hidden = false;
      dialog.setAttribute('aria-labelledby', 'feedbackTitle');
      sent = false;
    }
    const detail = { view: null };
    document.dispatchEvent(new CustomEvent('btl:feedback-open', { detail }));
    view = detail.view;
    contextNote.hidden = !view;
    contextNote.textContent = view ? 'Includes a link to block ' + view.block.toLocaleString() + '.' : '';
    dialog.showModal();
    if (!sending) message.focus();
  });
  dialog.querySelector('.fb-close').onclick = () => dialog.close();
  dialog.querySelector('#feedbackDone').onclick = () => dialog.close();
  form.addEventListener('change', () => {
    const category = new FormData(form).get('category');
    message.placeholder = category === 'bug' ? 'What happened, and what did you expect?' : category === 'idea' ? "I'd love to be able to…" : 'What worked well? What was confusing?';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending) return;
    if (!message.value.trim()) { message.setCustomValidity('Please write a message.'); message.reportValidity(); return; }
    message.setCustomValidity('');
    sending = true;
    send.disabled = true;
    sendLabel.textContent = 'Sending…';
    status.textContent = '';
    const data = new FormData(form);
    const endpoint = ['bitcointimelapse.com', 'www.bitcointimelapse.com', 'utxo.aiception.ai'].includes(location.hostname)
      ? '/api/feedback' : 'https://bitcointimelapse.com/api/feedback';
    try {
      const response = await fetch(endpoint, {
        method:'POST', credentials:'omit', headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(25000),
        body:JSON.stringify({category:data.get('category'), message:data.get('message').trim(), email:data.get('email').trim(), website:data.get('website'), source:document.getElementById('vid') ? 'explorer' : 'guide', block:view?.block ?? null}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) {
        throw new Error(response.status === 429 ? 'Please wait a few minutes before sending another message.' : body.error || 'Could not send right now. Your message is still here; please try again.');
      }
      sent = true;
      form.reset();
      form.hidden = true;
      dialog.querySelector('header').hidden = true;
      success.hidden = false;
      dialog.setAttribute('aria-labelledby', 'feedbackSuccessTitle');
      success.focus();
    } catch (error) {
      status.textContent = error.name === 'TimeoutError' || error.name === 'TypeError' ? 'Could not confirm delivery. Your message is still here; please try again.' : error.message;
    } finally {
      sending = false;
      send.disabled = false;
      sendLabel.textContent = 'Send feedback';
    }
  });
  message.addEventListener('input', () => message.setCustomValidity(''));
})();
