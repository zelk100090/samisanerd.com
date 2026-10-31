(() => {
  const form = document.getElementById('form');
  const pw = document.getElementById('password');
  const msg = document.getElementById('msg');
  const btn = document.getElementById('submit');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    btn.disabled = true; btn.textContent = 'Signing in…'; msg.textContent = '';
    try {
      const r = await fetch('api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw.value }),
      });
      if (r.ok) { location.replace('./'); return; }
      msg.textContent = (await r.json().catch(() => ({}))).error || 'Sign-in failed. Try again.';
      pw.select();
    } catch {
      msg.textContent = "Can't reach the server. Check your connection and try again.";
    }
    btn.disabled = false; btn.textContent = 'Sign in';
  });
})();
