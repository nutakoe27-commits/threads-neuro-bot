export class Camera {
  constructor(mapWidth, mapHeight) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.x = mapWidth / 2;
    this.y = mapHeight / 2;
    this.zoom = 1;
    this.viewWidth = 800;
    this.viewHeight = 600;
    this.minZoom = 0.3;
    this.maxZoom = 2.4;
  }

  setViewport(w, h) {
    this.viewWidth = w;
    this.viewHeight = h;
    // Never zoom out past "the whole map fits", it just wastes screen space.
    this.minZoom = Math.min(1.6, Math.max(0.2, Math.min(w / this.mapWidth, h / this.mapHeight)));
    if (this.zoom < this.minZoom) this.zoom = this.minZoom;
    this.clamp();
  }

  clamp() {
    const halfW = this.viewWidth / (2 * this.zoom);
    const halfH = this.viewHeight / (2 * this.zoom);
    if (halfW * 2 >= this.mapWidth) this.x = this.mapWidth / 2;
    else this.x = Math.max(halfW, Math.min(this.mapWidth - halfW, this.x));
    if (halfH * 2 >= this.mapHeight) this.y = this.mapHeight / 2;
    else this.y = Math.max(halfH, Math.min(this.mapHeight - halfH, this.y));
  }

  move(dx, dy) {
    this.x += dx;
    this.y += dy;
    this.clamp();
  }

  centerOn(x, y) {
    this.x = x;
    this.y = y;
    this.clamp();
  }

  zoomAt(screenX, screenY, factor) {
    const before = this.screenToWorld(screenX, screenY);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    const after = this.screenToWorld(screenX, screenY);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  worldToScreen(x, y) {
    return {
      x: (x - this.x) * this.zoom + this.viewWidth / 2,
      y: (y - this.y) * this.zoom + this.viewHeight / 2,
    };
  }

  screenToWorld(x, y) {
    return {
      x: (x - this.viewWidth / 2) / this.zoom + this.x,
      y: (y - this.viewHeight / 2) / this.zoom + this.y,
    };
  }

  get bounds() {
    const halfW = this.viewWidth / (2 * this.zoom);
    const halfH = this.viewHeight / (2 * this.zoom);
    return { left: this.x - halfW, top: this.y - halfH, right: this.x + halfW, bottom: this.y + halfH };
  }
}
