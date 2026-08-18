async function submitCase(event) {
  event.preventDefault();

  const form = event.target;
  const message = document.getElementById('form-message');
  const formData = Object.fromEntries(new FormData(form).entries());

  message.textContent = 'Sending your enquiry...';
  message.style.color = '#0b6b50';

  try {
    const response = await fetch('/api/enquiries', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(formData),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Unable to send enquiry.');
    }

    message.textContent = data.message || 'Your enquiry has been received.';
    form.reset();
  } catch (error) {
    message.textContent = error.message || 'Something went wrong. Please try again later.';
    message.style.color = '#b42318';
  }
}
