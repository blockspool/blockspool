export interface FramedSectionOptions {
  title: string;
  rows: string[];
  titleWidth?: number;
}

export interface FramedListOptions {
  title: string;
  marker: string;
  items: string[];
  itemWidth?: number;
}

export interface PrintFramedListOptions extends FramedListOptions {
  colorize: (value: string) => string;
}

const BOX_HORIZONTAL = '─'.repeat(57);
const DEFAULT_TITLE_WIDTH = 56;
const DEFAULT_ITEM_WIDTH = 55;

export function renderFramedSection(options: FramedSectionOptions): string[] {
  const titleWidth = options.titleWidth ?? DEFAULT_TITLE_WIDTH;

  return [
    `┌${BOX_HORIZONTAL}┐`,
    `│ ${options.title.padEnd(titleWidth)}│`,
    `├${BOX_HORIZONTAL}┤`,
    ...options.rows.map((row) => `│ ${row}│`),
    `└${BOX_HORIZONTAL}┘`,
  ];
}

export function renderFramedList(options: FramedListOptions): string[] {
  const itemWidth = options.itemWidth ?? DEFAULT_ITEM_WIDTH;

  return renderFramedSection({
    title: options.title,
    rows: options.items.map((item) => `${options.marker} ${item.padEnd(itemWidth)}`),
  });
}

export function printFramedList(options: PrintFramedListOptions): void {
  for (const line of renderFramedList(options)) {
    console.log(options.colorize(line));
  }
}
