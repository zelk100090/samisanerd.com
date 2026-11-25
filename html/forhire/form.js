const submit = document.querySelector('#submit');
const message = document.querySelector('#message');
const form = document.querySelector('#form');

form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const res = await fetch("/api/collections/nfhSubmissions/records", { method: 'POST', body: new FormData(form) });
    form.reset()
    message.textContent = 'submitted'
});