import type { Platform, PlatformResearch, SimilarArticle } from './scorer.js';
import type { AgentTool } from '../../agent/core.js';

/**
 * note・Zenn 共通のリサーチ基底クラス
 * 
 * Fetch MCP でプラットフォームの検索ページを直接取得して URL を抽出する
 */
export abstract class BaseResearcher {
  protected abstract readonly platform: Platform;
  /** 検索ページの URL テンプレート・`{query}` を置換して使う */
  protected abstract readonly searchUrl: string;
  
  constructor(
    protected readonly fetchTool: AgentTool | null,
    protected readonly debug: boolean = false
  ) {}
  
  public async research(topic: string): Promise<PlatformResearch> {
    this.log(`Researching "${topic}" On ${this.platform}...`);
    
    try {
      const urls = await this.searchArticles(topic);
      this.log(`Found ${urls.length} URLs`);
      
      const articles = await this.fetchArticles(urls);
      this.log(`Parsed ${articles.length} Articles`);
      
      return { platform: this.platform, topic, articles };
    }
    catch(error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`Error : ${errorMessage}`);
      return { platform: this.platform, topic, articles: [], error: errorMessage };
    }
  }
  
  /** Search (Fetch MCP で検索ページを直接取得) */
  private async searchArticles(topic: string): Promise<Array<string>> {
    if(this.fetchTool == null) {
      this.log('Fetch Tool Not Available');
      return [];
    }
    
    const url = this.searchUrl.replace('{query}', encodeURIComponent(topic));
    this.log(`Fetching Search Page : ${url}`);
    
    try {
      const html = await this.fetchTool.execute({ url });
      const urls = this.extractUrls(html);
      this.log(`Extracted ${urls.length} Article URLs`);
      return urls;
    }
    catch(error) {
      this.log('Failed To Fetch Search Page :', error);
      return [];
    }
  }
  
  /** 検索結果 HTML から記事 URL を抽出する (サブクラスで実装) */
  protected abstract extractUrls(html: string): Array<string>;
  
  /** Fetch & Parse (各記事ページを取得して解析) */
  private async fetchArticles(urls: Array<string>): Promise<Array<SimilarArticle>> {
    if(this.fetchTool == null || urls.length === 0) return [];
    
    const results = await Promise.allSettled(
      urls.slice(0, 5).map(url => this.fetchAndParse(url))
    );
    
    return results
      .filter((result): result is PromiseFulfilledResult<SimilarArticle | null> => result.status === 'fulfilled')
      .map(result => result.value)
      .filter((article): article is SimilarArticle => article != null);
  }
  
  private async fetchAndParse(url: string): Promise<SimilarArticle | null> {
    if(this.fetchTool == null) return null;
    
    try {
      this.log(`Fetching Article : ${url}`);
      const html = await this.fetchTool.execute({ url });
      return this.parseArticle(url, html);
    }
    catch(error) {
      this.log(`Failed To Fetch ${url} :`, error);
      return null;
    }
  }
  
  /** 記事ページ HTML からメタ情報を抽出する (サブクラスで実装) */
  protected abstract parseArticle(url: string, html: string): SimilarArticle | null;
  
  protected log(message: string, ...args: Array<unknown>): void {
    if(this.debug) console.log(`[${this.platform}Researcher] ${message}`, ...args);
  }
}
