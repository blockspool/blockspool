/**
 * Type declarations for neo-blessed
 *
 * Neo-blessed is a fork of blessed with modern Node.js support.
 * This is a minimal type definition for the features we use.
 */

declare module 'neo-blessed' {
  export namespace Widgets {
    interface NodeOptions {
      parent?: Node;
      top?: number | string;
      left?: number | string;
      right?: number | string;
      bottom?: number | string;
      width?: number | string;
      height?: number | string;
      hidden?: boolean;
      style?: StyleOptions;
    }

    interface StyleOptions {
      fg?: string;
      bg?: string;
      bold?: boolean;
      underline?: boolean;
      border?: {
        fg?: string;
        bg?: string;
      };
    }

    interface BoxOptions extends NodeOptions {
      content?: string;
      label?: string;
      border?: { type?: 'line' | 'bg' } | 'line' | 'bg';
      padding?: number | { left?: number; right?: number; top?: number; bottom?: number };
      tags?: boolean;
      scrollable?: boolean;
      alwaysScroll?: boolean;
      scrollbar?: {
        ch?: string;
        inverse?: boolean;
      };
    }

    interface ScreenOptions {
      smartCSR?: boolean;
      title?: string;
      fullUnicode?: boolean;
      tags?: boolean;
      dockBorders?: boolean;
    }

    interface Node {
      hidden: boolean;
      show(): void;
      hide(): void;
      focus(): void;
      setFront(): void;
      destroy(): void;
    }

    interface BoxElement extends Node {
      setContent(content: string): void;
      getContent(): string;
      setLabel(label: string): void;
    }

    // Alias for backwards compatibility
    type Box = BoxElement;

    interface Screen extends Node {
      render(): void;
      key(keys: string | string[], callback: (ch: string, key: KeyEvent) => void): void;
    }

    interface KeyEvent {
      full: string;
      name: string;
      ctrl: boolean;
      shift: boolean;
      meta: boolean;
    }
  }

  export function screen(options?: Widgets.ScreenOptions): Widgets.Screen;
  export function box(options?: Widgets.BoxOptions): Widgets.BoxElement;

  const blessed: {
    screen: typeof screen;
    box: typeof box;
    Widgets: typeof Widgets;
  };

  export default blessed;
}
