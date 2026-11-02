'use strict';

const Fireworks = (() => {
  const SHOW_MS = 10000;
  const LAST_LAUNCH_MS = 6500;
  const LAUNCH_GAP_MS = 350;
  const ROCKET_GRAVITY = 600;
  const SPARK_GRAVITY = 160;
  const SPARK_DRAG = 1.2;
  const MAX_PIXEL_RATIO = 2;

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const between = (low, high) => low + Math.random() * (high - low);
  let running = false;

  function newRocket(width, height) {
    const apexHeight = height * between(0.5, 0.8);
    return { x: between(width * 0.12, width * 0.88), y: height, vx: between(-40, 40), vy: -Math.sqrt(2 * ROCKET_GRAVITY * apexHeight), hue: between(0, 360) };
  }

  function burst(rocket) {
    const count = Math.round(between(70, 110));
    const power = between(180, 340);
    return Array.from({ length: count }, () => {
      const angle = between(0, 2 * Math.PI);
      const speed = power * Math.sqrt(Math.random());
      return {
        x: rocket.x,
        y: rocket.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        hue: rocket.hue + between(-25, 25),
        life: between(1.1, 1.7),
        age: 0,
      };
    });
  }

  function launch() {
    if (running || reducedMotion.matches) return;
    running = true;

    const canvas = h('canvas', { class: 'fireworks', 'aria-hidden': 'true' });
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    let width = 0;
    let height = 0;
    const fit = () => {
      const ratio = Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO);
      width = innerWidth;
      height = innerHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    fit();
    addEventListener('resize', fit);

    const rockets = [];
    let sparks = [];
    const start = performance.now();
    let last = start;
    let nextLaunch = start;
    let frame = 0;

    const finish = () => {
      cancelAnimationFrame(frame);
      clearTimeout(cutoff);
      removeEventListener('resize', fit);
      canvas.remove();
      running = false;
    };
    const cutoff = setTimeout(finish, SHOW_MS);

    const step = (now) => {
      if (now - start >= SHOW_MS) return finish();
      const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
      last = now;

      if (now - start < LAST_LAUNCH_MS && now >= nextLaunch) {
        rockets.push(newRocket(width, height));
        nextLaunch = now + LAUNCH_GAP_MS * between(0.6, 1.4);
      }

      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';

      for (let i = rockets.length - 1; i >= 0; i--) {
        const rocket = rockets[i];
        rocket.vy += ROCKET_GRAVITY * dt;
        rocket.x += rocket.vx * dt;
        rocket.y += rocket.vy * dt;
        if (rocket.vy >= 0) {
          sparks.push(...burst(rocket));
          rockets.splice(i, 1);
          continue;
        }
        ctx.fillStyle = `hsl(${rocket.hue} 100% 85%)`;
        ctx.fillRect(rocket.x - 1.5, rocket.y - 1.5, 3, 3);
      }

      const drag = Math.exp(-SPARK_DRAG * dt);
      sparks = sparks.filter((spark) => (spark.age += dt) < spark.life);
      for (const spark of sparks) {
        spark.vx *= drag;
        spark.vy = spark.vy * drag + SPARK_GRAVITY * dt;
        spark.x += spark.vx * dt;
        spark.y += spark.vy * dt;
        ctx.fillStyle = `hsl(${spark.hue} 100% 60% / ${1 - spark.age / spark.life})`;
        ctx.fillRect(spark.x - 1.5, spark.y - 1.5, 3, 3);
      }

      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  return { launch };
})();
