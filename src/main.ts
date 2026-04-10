import { Plugin, MarkdownView, Notice, Menu, requestUrl, Modal, PluginSettingTab, Setting, App, Editor } from 'obsidian';

// ==================== Types ====================

interface LumeSettings {
    apiKey: string;
    model: string;
    persona: string;
    proxyUrl: string;
}

const DEFAULT_SETTINGS: LumeSettings = {
    apiKey: '',
    model: 'llama-3.3-70b-versatile',
    persona: 'Elite Coach',
    proxyUrl: 'https://api.lume.ai/v1/chat' // Placeholder for future Proxy
};

interface SuggestionItem {
    text: string;
    tag?: string;
    reason?: string;
}

interface AnalysisResult {
    errors: Array<{
        word: string;
        fix: string;
        reason: string;
    }>;
    better: string;
}

interface RephraseStyle {
    style: string;
    text: string;
}

// ==================== Modal ====================

class LumeSuggestionModal extends Modal {
    constructor(
        app: App, 
        private titleStr: string, 
        private items: SuggestionItem[], 
        private originalText: string | null, 
        private onSelect: (text: string) => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        if (modalEl) modalEl.addClass("lume-popover-container");
        
        contentEl.empty();
        contentEl.createEl("div", { text: this.titleStr, cls: "lume-popover-title" });

        if (this.originalText) {
            const originalCard = contentEl.createEl("div", { cls: "lume-suggestion-card" });
            originalCard.style.borderColor = "rgba(255,255,255,0.2)";
            originalCard.style.opacity = "0.8";
            originalCard.createEl("div", { text: "ORIGINAL", cls: "lume-style-tag" }).style.color = "#888";
            originalCard.createEl("div", { text: this.originalText });
        }

        contentEl.createEl("hr").style.borderTop = "1px solid rgba(255,255,255,0.1)";

        this.items.forEach(item => {
            const card = contentEl.createEl("div", { cls: "lume-suggestion-card" });
            if (item.tag) card.createEl("div", { text: item.tag, cls: "lume-style-tag" });
            card.createEl("div", { text: item.text });
            if (item.reason) card.createEl("div", { text: item.reason, cls: "lume-reason-text" });
            
            card.onclick = () => { 
                this.onSelect(item.text); 
                this.close(); 
            };
        });
    }
}

// ==================== Settings ====================

class LumeSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: LumePlugin) { 
        super(app, plugin); 
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "Lume Settings" });

        new Setting(containerEl)
            .setName("API Key")
            .setDesc("Your Groq API Key or Lume License Key.")
            .addText(t => t
                .setPlaceholder("gsk_...")
                .setValue(this.plugin.settings.apiKey)
                .onChange(async v => { 
                    this.plugin.settings.apiKey = v; 
                    await this.plugin.saveSettings(); 
                }));

        new Setting(containerEl)
            .setName("Model ID")
            .addText(t => t
                .setValue(this.plugin.settings.model)
                .onChange(async v => { 
                    this.plugin.settings.model = v; 
                    await this.plugin.saveSettings(); 
                }));

        new Setting(containerEl)
            .setName("Default Persona")
            .addText(t => t
                .setValue(this.plugin.settings.persona)
                .onChange(async v => { 
                    this.plugin.settings.persona = v; 
                    await this.plugin.saveSettings(); 
                }));
        
        new Setting(containerEl)
            .setName("Proxy URL")
            .setDesc("Internal use for Lume subscription service.")
            .addText(t => t
                .setValue(this.plugin.settings.proxyUrl)
                .onChange(async v => { 
                    this.plugin.settings.proxyUrl = v; 
                    await this.plugin.saveSettings(); 
                }));
    }
}

// ==================== Main Plugin ====================

export default class LumePlugin extends Plugin {
    settings: LumeSettings;
    errorMarks: Array<{
        line: number;
        word: string;
        fix: string;
        reason: string;
        betterSentence: string;
    }> = [];

    async onload() {
        console.log("Loading Lume v1.0.0...");
        await this.loadSettings();
        this.addSettingTab(new LumeSettingTab(this.app, this));

        // Status Bar items
        const checkBtn = this.addStatusBarItem();
        checkBtn.setText("🔍 Analyze");
        checkBtn.addClass("mod-clickable");
        checkBtn.onclick = () => this.analyzeCurrentLine();

        const rephraseBtn = this.addStatusBarItem();
        rephraseBtn.setText("✨ Lume");
        rephraseBtn.addClass("mod-clickable");
        rephraseBtn.onclick = () => this.rephraseSelection();

        const clearBtn = this.addStatusBarItem();
        clearBtn.setText("🧹 Reset");
        clearBtn.addClass("mod-clickable");
        clearBtn.onclick = () => this.clearAllHighlights();

        // Editor Context Menu
        this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
            menu.addSeparator();
            menu.addItem(item => item
                .setTitle("Lume: Analyze Line")
                .setIcon("search")
                .onClick(() => this.analyzeCurrentLine()));
            
            if (editor.getSelection()) {
                menu.addItem(item => item
                    .setTitle("Lume: Rephrase")
                    .setIcon("sparkles")
                    .onClick(() => this.rephraseSelection()));
                
                menu.addItem(item => item
                    .setTitle("Lume: Translate to EN")
                    .setIcon("languages")
                    .onClick(() => this.translateSelection()));
            }
        }));

        // Interaction with highlights
        this.registerDomEvent(document, "mousedown", (evt: MouseEvent) => {
            const target = evt.target as HTMLElement;
            if (target && target.classList.contains("lume-grammar-error")) {
                const errorData = this.errorMarks.find(m => m.word === target.innerText);
                if (errorData) this.showErrorDetail(errorData);
            }
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() { 
        await this.saveData(this.settings); 
    }

    async analyzeCurrentLine() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        
        const editor = view.editor;
        const lineNum = editor.getCursor().line;
        const lineText = editor.getLine(lineNum);
        
        if (!lineText.trim()) return;
        if (!this.settings.apiKey) {
            new Notice("Please set your API Key in Lume settings.");
            return;
        }

        new Notice("🔬 Deep Analysis...");
        const result = await this.callAI(`Analyze this English sentence for errors: "${lineText.replace(/"/g, "'")}". Return strictly valid JSON: {"errors": [{"word": "...", "fix": "...", "reason": "..."}], "better": "..."}`, true);
        
        if (result) {
            try {
                const jsonMatch = result.match(/\{[\s\S]*\}/);
                if (!jsonMatch) throw new Error("No JSON found");
                const data: AnalysisResult = JSON.parse(jsonMatch[0]);
                this.applyVisualDiff(editor, lineNum, lineText, data.errors, data.better);
            } catch (e) { 
                console.error("AI Parse Error:", e);
                new Notice("Lume: Error parsing AI response."); 
            }
        }
    }

    async rephraseSelection() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        
        const editor = view.editor;
        const selection = editor.getSelection() || editor.getLine(editor.getCursor().line);
        
        if (!selection.trim()) return;
        if (!this.settings.apiKey) {
            new Notice("Please set your API Key in Lume settings.");
            return;
        }

        new Notice("✨ Luming...");
        const result = await this.callAI(`Persona: ${this.settings.persona}. Target sentence: "${selection}". Rephrase in 4 styles (Business, Casual, Academic, Creative). Return strictly valid JSON array: [{"style": "...", "text": "..."}]`, true);
        
        if (result) {
            try {
                const jsonMatch = result.match(/\[[\s\S]*\]/);
                if (!jsonMatch) throw new Error("No JSON found");
                const variations: RephraseStyle[] = JSON.parse(jsonMatch[0]);
                
                new LumeSuggestionModal(
                    this.app, 
                    "Rephrase", 
                    variations.map(v => ({ text: v.text, tag: v.style })), 
                    selection, 
                    selected => editor.replaceSelection(selected)
                ).open();
            } catch (e) { 
                new Notice("Lume: Error processing styles."); 
            }
        }
    }

    showErrorDetail(errorData: any) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;

        new LumeSuggestionModal(
            this.app, 
            `Issue: ${errorData.word}`, 
            [
                { tag: "FIX", text: errorData.fix, reason: errorData.reason }, 
                { tag: "REVISION", text: errorData.betterSentence, reason: "Optimized context" }
            ], 
            errorData.word, 
            selected => {
                const editor = view.editor;
                const lineText = editor.getLine(errorData.line);
                if (selected === errorData.betterSentence) {
                    editor.setLine(errorData.line, selected);
                } else {
                    editor.setLine(errorData.line, lineText.replace(`<span class="lume-grammar-error">${errorData.word}</span>`, selected));
                }
            }
        ).open();
    }

    applyVisualDiff(editor: Editor, lineNum: number, lineText: string, errors: any[], better: string) {
        // Clear previous marks for this line
        this.errorMarks = this.errorMarks.filter(m => m.line !== lineNum);
        
        let newLine = lineText;
        errors.forEach(err => {
            // Very simple replacement - in production, use a more robust strategy
            const escapedWord = err.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${escapedWord}\\b`, 'g');
            
            if (newLine.match(regex)) {
                this.errorMarks.push({ 
                    line: lineNum, 
                    word: err.word, 
                    fix: err.fix, 
                    reason: err.reason, 
                    betterSentence: better 
                });
                newLine = newLine.replace(regex, `<span class="lume-grammar-error">${err.word}</span>`);
            }
        });
        
        editor.setLine(lineNum, newLine);
    }

    async translateSelection() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        
        const editor = view.editor;
        const selection = editor.getSelection();
        if (!selection) return;

        new Notice("🌐 Translating...");
        const result = await this.callAI(`Translate the following text to English, maintaining any markdown formatting: ${selection}`);
        if (result) editor.replaceSelection(result.trim());
    }

    clearAllHighlights() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
            const editor = view.editor;
            for (let i = 0; i < editor.lineCount(); i++) {
                let line = editor.getLine(i);
                if (line.includes("lume-grammar-error")) {
                    editor.setLine(i, line.replace(/<span class="lume-grammar-error">(.*?)<\/span>/g, "$1"));
                }
            }
        }
        this.errorMarks = [];
        new Notice("Lume highlights cleared.");
    }

    async callAI(prompt: string, isJson: boolean = false): Promise<string | null> {
        try {
            const response = await requestUrl({
                url: "https://api.groq.com/openai/v1/chat/completions",
                method: "POST",
                headers: { 
                    "Authorization": `Bearer ${this.settings.apiKey}`, 
                    "Content-Type": "application/json" 
                },
                body: JSON.stringify({
                    model: this.settings.model,
                    messages: [
                        { role: "system", content: isJson ? "You are a helpful English coach. Return JSON ONLY." : "You are an Elite English coach." }, 
                        { role: "user", content: prompt }
                    ],
                    temperature: 0.1
                })
            });
            return response.json.choices[0].message.content;
        } catch (error) { 
            console.error("Lume AI Call Error:", error);
            new Notice("Check your API connection or key.");
            return null; 
        }
    }
}
