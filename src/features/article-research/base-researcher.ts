import type { Platform, PlatformResearch, SimilarArticle } from './scorer.js';
import type { AgentTool } from '../../agent/core.js';

// ----------------------------------------------------------------
// BaseResearcher
// ----------------------------------------------------------------

/**
 * note / Zenn 共通のリサーチ基底クラス。
 * Brave Search を廃止し、Fetch MCP でプラットフォームの検索ページを
 * 直接取得して URL を抽出する方式に統一。APIキー不要・完全無料。
 */
export abstract class BaseResearcher {
  protected abstract readonly platform: Platform;
  /** 検索ページの URL テンプレート。{query} を置換して使う */
  protected abstract readonly searchUrl: string;
  
  constructor(
    protected readonly fetchTool: AgentTool | null,
    protected readonly debug: boolean = false
  ) {}
  
  async research(topic: string): Promise<PlatformResearch> {
    this.log(`Researching "${topic}" on ${this.platform}...`);
    
    try {
      const urls = await this.searchArticles(topic);
      this.log(`Found ${urls.length} URLs`);
      
      const articles = await this.fetchArticles(urls);
      this.log(`Parsed ${articles.length} articles`);
      
      return { platform: this.platform, topic, articles };
    }
    catch(err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log(`Error: ${error}`);
      return { platform: this.platform, topic, articles: [], error };
    }
  }
  
  // ----------------------------------------------------------------
  // Search（Fetch MCP で検索ページを直接取得）
  // ----------------------------------------------------------------
  
  private async searchArticles(topic: string): Promise<Array<string>> {
    if(this.fetchTool == null) {
      this.log('Fetch tool not available');
      return [];
    }
    
    const url = this.searchUrl.replace('{query}', encodeURIComponent(topic));
    this.log(`Fetching search page: ${url}`);
    
    try {
      const html = await this.fetchTool.execute({ url });
      const urls = this.extractUrls(html);
      this.log(`Extracted ${urls.length} article URLs`);
      return urls;
    }
    catch(err) {
      this.log('Failed to fetch search page:', err);
      return [];
    }
  }
  
  /** 検索結果 HTML から記事 URL を抽出する（サブクラスで実装） */
  protected abstract extractUrls(html: string): Array<string>;
  
  // ----------------------------------------------------------------
  // Fetch & parse（各記事ページを取得して解析）
  // ----------------------------------------------------------------
  
  private async fetchArticles(urls: Array<string>): Promise<Array<SimilarArticle>> {
    if(this.fetchTool == null || urls.length === 0) return [];
    
    const results = await Promise.allSettled(
      urls.slice(0, 5).map(url => this.fetchAndParse(url))
    );
    
    return results
      .filter((r): r is PromiseFulfilledResult<SimilarArticle | null> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter((a): a is SimilarArticle => a != null);
  }
  
  private async fetchAndParse(url: string): Promise<SimilarArticle | null> {
    if(this.fetchTool == null) return null;
    
    try {
      this.log(`Fetching article: ${url}`);
      const html = await this.fetchTool.execute({ url });
      return this.parseArticle(url, html);
    }
    catch(err) {
      this.log(`Failed to fetch ${url}:`, err);
      return null;
    }
  }
  
  /** 記事ページ HTML からメタ情報を抽出する（サブクラスで実装） */
  protected abstract parseArticle(url: string, html: string): SimilarArticle | null;
  
  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------
  
  protected log(message: string, ...args: Array<unknown>): void {
    if(this.debug) {
      console.log(`[${this.platform}Researcher] ${message}`, ...args);
    }
  }
}
