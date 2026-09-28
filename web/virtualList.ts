// virtualList.ts - Danh sách cuộn ảo: chỉ tạo DOM cho các dòng đang nhìn thấy.

export interface VirtualListOptions<T> {
  container: HTMLElement; // phần tử cuộn (overflow: auto)
  rowHeight: number;
  renderRow: (item: T, index: number, el: HTMLElement) => void;
  overscan?: number;
}

export class VirtualList<T> {
  private items: T[] = [];
  private readonly spacer: HTMLDivElement;
  private readonly pool: HTMLElement[] = [];
  private frame = 0;

  constructor(private readonly opts: VirtualListOptions<T>) {
    this.spacer = document.createElement("div");
    this.spacer.className = "vl-spacer";
    opts.container.append(this.spacer);
    opts.container.addEventListener("scroll", () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(opts.container);
  }

  setItems(items: T[]) {
    this.items = items;
    this.spacer.style.height = `${items.length * this.opts.rowHeight}px`;
    this.render();
  }

  refresh() {
    this.render();
  }

  // Phần tử cuộn cùng các dòng: đặt lớp phủ (ô sửa) vào đây để nó trôi theo khi cuộn.
  get host(): HTMLElement {
    return this.spacer;
  }

  rowTop(index: number): number {
    return index * this.opts.rowHeight;
  }

  // Chiều cao phần nằm trên danh sách trong vùng cuộn (tiêu đề sticky).
  private get headerHeight(): number {
    return this.spacer.offsetTop;
  }

  // Cuộn tối thiểu để dòng `index` nằm trong vùng nhìn thấy (không bị tiêu đề che).
  scrollIntoView(index: number) {
    const { container, rowHeight } = this.opts;
    const top = index * rowHeight;
    const bottom = top + rowHeight + this.headerHeight;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
  }

  get pageSize(): number {
    const h = this.opts.container.clientHeight - this.headerHeight;
    return Math.max(1, Math.floor(h / this.opts.rowHeight) - 1);
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render() {
    const { container, rowHeight, renderRow } = this.opts;
    const overscan = this.opts.overscan ?? 8;
    const scrollTop = Math.max(0, container.scrollTop - this.headerHeight);
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const last = Math.min(this.items.length, Math.ceil((scrollTop + container.clientHeight) / rowHeight) + overscan);
    const count = Math.max(0, last - first);

    while (this.pool.length < count) {
      const el = document.createElement("div");
      el.className = "vl-row";
      el.setAttribute("role", "row");
      this.spacer.append(el);
      this.pool.push(el);
    }
    this.pool.forEach((el, i) => {
      if (i >= count) {
        el.hidden = true;
        return;
      }
      const index = first + i;
      el.hidden = false;
      el.style.transform = `translateY(${index * rowHeight}px)`;
      el.dataset.index = String(index);
      renderRow(this.items[index]!, index, el);
    });
  }
}
