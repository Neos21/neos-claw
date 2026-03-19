import { NoteResearcher } from './note-researcher.js';
import { score, formatReport } from './scorer.js';
import { ZennResearcher } from './zenn-researcher.js';

import type { ArticleReport } from './scorer.js';
import type { AgentCore } from '../../agent/core.js';

export interface ArticleResearcherOptions {
  debug?: boolean;
}

/** note と Zenn の記事ネタ判定を行うオーケストレータ・Fetch MCP のみを使用 */
export class ArticleResearcher {
  private noteResearcher: NoteResearcher;
  private zennResearcher: ZennResearcher;
  private debug: boolean;
  
  constructor(core: AgentCore, options: ArticleResearcherOptions = {}) {
    this.debug = options.debug ?? false;
    
    // JSON 取得用 : fetch_json を優先 (変換なしで JSON をそのまま返す)
    const fetchJsonTool =
      core.getTools().find(tool => tool.name === 'fetch_json') ??
      core.getTools().find(tool => tool.name === 'fetch_txt') ??
      null;
    
    // HTML・テキスト取得用 : fetch_readable (Readability でパース済みテキスト)
    const fetchTool =
      core.getTools().find(tool => tool.name === 'fetch_readable') ??
      core.getTools().find(tool => tool.name === 'fetch_markdown') ??
      null;
    
    if(fetchJsonTool == null) console.warn('[ArticleResearcher] fetch_json / fetch_txt Not Available');
    if(fetchTool == null)     console.warn('[ArticleResearcher] fetch_readable Not Available');
    
    this.noteResearcher = new NoteResearcher(fetchJsonTool, fetchTool, this.debug);
    this.zennResearcher = new ZennResearcher(fetchJsonTool, fetchTool, this.debug);
  }
  
  /** note と Zenn を並列調査してレポートを返す */
  async research(topic: string): Promise<ArticleReport> {
    this.log(`Starting Research For : "${topic}"`);
    
    const [noteResearch, zennResearch] = await Promise.all([
      this.noteResearcher.research(topic),
      this.zennResearcher.research(topic)
    ]);
    
    return {
      topic,
      generatedAt: new Date(),
      note: { research: noteResearch, score: score(noteResearch) },
      zenn: { research: zennResearch, score: score(zennResearch) }
    };
  }
  
  /** `research()` を実行してテキストレポートを返す */
  async researchAndFormat(topic: string): Promise<string> {
    const report = await this.research(topic);
    return formatReport(report);
  }
  
  private log(message: string, ...args: Array<unknown>): void {
    if(this.debug) {
      console.log(`[ArticleResearcher] ${message}`, ...args);
    }
  }
}

export type { ArticleReport } from './scorer.js';
export { formatReport } from './scorer.js';
