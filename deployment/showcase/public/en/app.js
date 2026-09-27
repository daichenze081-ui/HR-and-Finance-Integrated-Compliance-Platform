(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const audio = $('narration');
  let deck, index = 0, playing = false, started = false, finished = false;
  let generation = 0, tailTimer = null, tailDue = 0, tailRemaining = 0;
  const format = seconds => {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  };
  function status(text) { $('playback-status').textContent = text; }
  function updateControls() {
    $('toggle-play').textContent = playing ? 'Ⅱ Pause' : finished ? '↻ Replay' : started ? '▶ Resume' : '▶ Start narration';
    $('toggle-play').setAttribute('aria-pressed', String(playing));
    $('previous').disabled = index === 0;
    $('next').disabled = index === deck.slides.length - 1;
    $('page-count').textContent = `${String(index + 1).padStart(2, '0')} / ${deck.slides.length}`;
  }
  function stopTail(preserve = false) {
    if (tailTimer !== null) {
      if (preserve) tailRemaining = Math.max(0, tailDue - performance.now());
      clearTimeout(tailTimer);
      tailTimer = null;
    }
    if (!preserve) tailRemaining = 0;
  }
  function endShow() {
    playing = false; finished = true; tailRemaining = 0;
    status('Presentation complete. Thank you for watching. Replay or download below.');
    updateControls();
  }
  function scheduleTail() {
    if (!playing) return;
    if (tailRemaining <= 0) tailRemaining = deck.tailSeconds * 1000;
    const currentGeneration = generation;
    tailDue = performance.now() + tailRemaining;
    status(index === deck.slides.length - 1 ? 'Narration complete' : 'Narration complete. Advancing shortly…');
    tailTimer = setTimeout(() => {
      tailTimer = null; tailRemaining = 0;
      if (!playing || generation !== currentGeneration) return;
      if (index + 1 < deck.slides.length) loadSlide(index + 1, true);
      else endShow();
    }, tailRemaining);
  }
  async function playAudio() {
    const token = generation;
    playing = true; started = true; finished = false;
    updateControls();
    if (audio.ended || tailRemaining > 0) { scheduleTail(); return; }
    try {
      await audio.play();
      if (token !== generation || !playing) return;
      status('Playing English narration');
    } catch (error) {
      if (token !== generation || error.name === 'AbortError') return;
      playing = false; updateControls();
      status(error.name === 'NotAllowedError'
        ? 'Click Resume to enable audio.'
        : 'Audio unavailable. Retry or read the transcript.');
    }
  }
  function pause() {
    playing = false; stopTail(true); audio.pause(); updateControls();
    status('Paused. Click Resume to continue.');
  }
  function loadSlide(nextIndex, shouldPlay = playing) {
    if (!deck || nextIndex < 0 || nextIndex >= deck.slides.length) return;
    generation += 1; stopTail(); audio.pause(); finished = false;
    index = nextIndex; playing = false;
    const slide = deck.slides[index];
    $('slide-image').src = slide.image;
    $('slide-image').alt = `Slide ${index + 1}: ${slide.titleZh}`;
    $('slide-title').textContent = slide.titleZh;
    $('slide-title-en').textContent = slide.titleEn;
    $('transcript-text').textContent = slide.narration;
    audio.src = slide.audio;
    audio.load();
    $('seek').value = 0; $('seek').max = slide.durationSeconds; $('seek').disabled = false;
    $('elapsed').textContent = '0:00'; $('slide-duration').textContent = format(slide.durationSeconds);
    document.querySelectorAll('#slide-list button').forEach((button, i) => {
      if (i === index) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    requestAnimationFrame(() => {
      const list = $('slide-list'), selected = list.querySelector('[aria-current="step"]');
      if (!selected) return;
      const bounds = list.getBoundingClientRect(), item = selected.getBoundingClientRect();
      if (item.top < bounds.top) list.scrollTop -= bounds.top - item.top;
      else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
    });
    history.replaceState(null, '', `#slide-${index + 1}`);
    updateControls();
    status(started ? 'Slide selected. Click Resume to listen.' : 'Click Start for English narration.');
    if (index + 1 < deck.slides.length) { const nextImage = new Image(); nextImage.src = deck.slides[index + 1].image; }
    if (shouldPlay) playAudio();
  }
  $('toggle-play').addEventListener('click', () => {
    if (playing) pause();
    else if (finished) loadSlide(0, true);
    else playAudio();
  });
  $('previous').addEventListener('click', () => loadSlide(index - 1));
  $('next').addEventListener('click', () => loadSlide(index + 1));
  $('mute').addEventListener('click', () => {
    audio.muted = !audio.muted;
    $('mute').setAttribute('aria-pressed', String(audio.muted));
    $('mute').textContent = audio.muted ? 'Muted' : 'Sound on';
  });
  $('fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if ($('player').requestFullscreen) await $('player').requestFullscreen();
      else status('Full screen unavailable. Try landscape orientation.');
    } catch { status('Full screen unavailable in this browser.'); }
  });
  document.addEventListener('fullscreenchange', () => { $('fullscreen').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; });
  audio.addEventListener('timeupdate', () => {
    $('seek').value = audio.currentTime || 0;
    $('elapsed').textContent = format(audio.currentTime);
  });
  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration)) { $('seek').max = audio.duration; $('slide-duration').textContent = format(audio.duration); }
  });
  audio.addEventListener('ended', () => { tailRemaining = deck.tailSeconds * 1000; if (playing) scheduleTail(); });
  audio.addEventListener('error', () => {
    if (!deck) return;
    playing = false; stopTail(); updateControls();
    status('Audio could not load. Slides and transcript remain available.');
  });
  $('seek').addEventListener('input', () => {
    stopTail(); finished = false;
    if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(Number($('seek').value), audio.duration);
    $('elapsed').textContent = format(audio.currentTime);
    if (playing && audio.paused && !audio.ended) playAudio();
  });
  document.addEventListener('keydown', event => {
    if (!deck || event.altKey || event.ctrlKey || event.metaKey || /INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY|A/.test(event.target.tagName)) return;
    if (event.code === 'Space') { event.preventDefault(); $('toggle-play').click(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); loadSlide(index + 1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); loadSlide(index - 1); }
  });
  window.addEventListener('hashchange', () => {
    if (!deck) return;
    const requested = /^#slide-(\d+)$/.exec(location.hash);
    if (requested) {
      const nextIndex = Math.min(Math.max(Number(requested[1]) - 1, 0), deck.slides.length - 1);
      if (nextIndex !== index) loadSlide(nextIndex);
    }
  });
  function makeDownloads() {
    for (const entry of deck.downloads) {
      const item = document.createElement(entry.url ? 'a' : 'div');
      if (entry.url) { item.href = entry.url; item.download = ''; }
      else item.className = 'unavailable';
      const label = document.createElement('strong'); label.textContent = entry.titleZh;
      const sub = document.createElement('span'); sub.textContent = entry.url ? entry.titleEn : 'Preparing';
      item.append(label, sub); $('download-list').append(item);
    }
  }
  fetch('/en/deck.json', { cache: 'no-cache' }).then(response => {
    if (!response.ok) throw Error('Manifest unavailable');
    return response.json();
  }).then(data => {
    if (!Array.isArray(data.slides) || !data.slides.length) throw Error('No slides');
    deck = data;
    $('total-duration').textContent = `${format(Math.round(deck.totalSeconds))} total`;
    for (const [i, slide] of deck.slides.entries()) {
      const li = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.setAttribute('aria-label', `Slide ${i + 1}: ${slide.titleZh}`);
      const number = document.createElement('span'); number.className = 'number'; number.textContent = String(i + 1).padStart(2, '0');
      const labels = document.createElement('span');
      for (const [className, value] of [['zh', slide.titleZh], ['en', slide.titleEn], ['duration', format(slide.durationSeconds)]]) {
        const span = document.createElement('span'); span.className = className; span.textContent = value; if(className === 'en') span.lang = 'en'; labels.append(span);
      }
      button.append(number, labels); button.addEventListener('click', () => loadSlide(i)); li.append(button); $('slide-list').append(li);
    }
    makeDownloads();
    const requested = /^#slide-(\d+)$/.exec(location.hash);
    const initial = requested ? Math.min(Math.max(Number(requested[1]) - 1, 0), deck.slides.length - 1) : 0;
    $('toggle-play').disabled = false; loadSlide(initial, false);
  }).catch(() => { status('Presentation could not load. Please refresh.'); });
})();
