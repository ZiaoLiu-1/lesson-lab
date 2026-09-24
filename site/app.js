const videos = Object.freeze({
  short: { id: 'RpbIJLIoFbI', title: 'Lesson Lab — short film (about 42 seconds)' },
  story: { id: '5w6XOYipABk', title: 'Lesson Lab — full showcase (3 minutes 55 seconds)' },
});

for (const button of document.querySelectorAll('[data-video]')) {
  const key = button.dataset.video;
  const video = videos[key];
  const player = button.closest('[data-player]');
  if (!video || !player || player.dataset.player !== key) continue;
  button.hidden = false;
  button.addEventListener('click', () => {
    if (player.querySelector('iframe')) return;
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=0&rel=0`;
    frame.title = video.title;
    frame.allow = 'encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.tabIndex = 0;
    player.replaceChildren(frame);
    frame.focus();
    document.getElementById('video-status').textContent = `${video.title} requested from YouTube. Use the player to start playback, or the YouTube link below if it does not load.`;
  }, { once: true });
}
