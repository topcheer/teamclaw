const tabs = Array.from(document.querySelectorAll('[data-gallery-target]'));
const frames = Array.from(document.querySelectorAll('.gallery-frame'));
const copyButtons = Array.from(document.querySelectorAll('.copy-button'));
const copyStatus = document.querySelector('.copy-status');
let copyStatusTimer = null;

function activateGallery(targetId) {
  tabs.forEach((tab) => {
    const active = tab.dataset.galleryTarget === targetId;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  frames.forEach((frame) => {
    const active = frame.id === targetId;
    frame.classList.toggle('is-active', active);
    frame.hidden = !active;
  });
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => activateGallery(tab.dataset.galleryTarget));
});

function showCopyStatus(message) {
  if (!copyStatus) return;
  copyStatus.textContent = message;
  copyStatus.classList.add('is-visible');
  window.clearTimeout(copyStatusTimer);
  copyStatusTimer = window.setTimeout(() => {
    copyStatus.classList.remove('is-visible');
  }, 1800);
}

async function copyText(button) {
  const targetId = button.dataset.copyTarget;
  const codeBlock = document.getElementById(targetId);
  if (!codeBlock) return;

  try {
    await navigator.clipboard.writeText(codeBlock.textContent.trim());
    button.classList.add('is-success');
    button.textContent = 'Copied';
    showCopyStatus('Command copied to clipboard.');
    window.setTimeout(() => {
      button.classList.remove('is-success');
      button.textContent = 'Copy';
    }, 1600);
  } catch (error) {
    showCopyStatus('Clipboard copy failed.');
  }
}

copyButtons.forEach((button) => {
  button.addEventListener('click', () => copyText(button));
});
