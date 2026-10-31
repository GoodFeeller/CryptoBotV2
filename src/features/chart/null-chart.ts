import type { ChartRenderer } from '../../core/ports.js'

/** Для бэктеста: картинки там никто не видит, а построение одной занимает десятки миллисекунд. */
export class NullChartRenderer implements ChartRenderer {
  async render(): Promise<Uint8Array> {
    return new Uint8Array()
  }
}
