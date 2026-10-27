/**
 * LuminaRead - Core Reader Application Logic
 * Features:
 * - IndexedDB storage for PDF files, position, book metadata
 * - PDF.js extraction & high-grade book-style typography formatting
 * - Reading position persistence (page and scroll offset remembered per book)
 * - Typography customization (font family, size, line-height, width, themes)
 * - Text-To-Speech (TTS) narration
 * - Dual view modes: Enhanced Reader & Original PDF Canvas
 */

// Configure PDF.js worker locally
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';
}

/* ==========================================================================
   IndexedDB Storage Manager
   ========================================================================== */
class BookDatabase {
  constructor() {
    this.dbName = 'LuminaReadDB';
    this.version = 1;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          const store = db.createObjectStore('books', { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      request.onerror = (e) => {
        console.error('IndexedDB open error:', e);
        reject(e);
      };
    });
  }

  async saveBook(book) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['books'], 'readwrite');
      const store = tx.objectStore('books');
      book.updatedAt = Date.now();
      const req = store.put(book);
      req.onsuccess = () => resolve(book);
      req.onerror = (e) => reject(e);
    });
  }

  async getBook(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['books'], 'readonly');
      const store = tx.objectStore('books');
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e);
    });
  }

  async getAllBooks() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['books'], 'readonly');
      const store = tx.objectStore('books');
      const req = store.getAll();
      req.onsuccess = () => {
        const books = req.result || [];
        books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(books);
      };
      req.onerror = (e) => reject(e);
    });
  }

  async updateProgress(id, currentPage, totalPages) {
    const book = await this.getBook(id);
    if (book) {
      book.currentPage = currentPage;
      if (totalPages) book.totalPages = totalPages;
      book.updatedAt = Date.now();
      return this.saveBook(book);
    }
  }

  async deleteBook(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['books'], 'readwrite');
      const store = tx.objectStore('books');
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e);
    });
  }
}

/* ==========================================================================
   State & App Controller
   ========================================================================== */
class LuminaReaderApp {
  constructor() {
    this.db = new BookDatabase();
    this.currentBook = null;
    this.pdfDoc = null;
    this.currentPageNum = 1;
    this.totalPages = 1;
    this.zoomScale = 1.25;
    this.viewMode = 'enhanced'; // 'enhanced' or 'canvas'
    this.isSpeaking = false;
    this.speechUtterance = null;

    // Preferences & Typography config
    this.settings = {
      fontFamily: "'Lora', serif",
      fontSize: 19,
      lineHeight: 1.8,
      contentWidth: 760,
      textAlign: 'justify',
      theme: 'theme-paper'
    };

    this.cachePageTexts = new Map(); // pageNum -> formatted text HTML

    this.init();
  }

  async init() {
    this.loadSettings();
    this.applySettings();
    this.bindDOM();
    this.bindEvents();

    try {
      await this.db.init();
      await this.renderLibrary();

      // Check last opened book from localStorage
      const lastOpenedId = localStorage.getItem('lumina_last_opened_id');
      if (lastOpenedId) {
        const book = await this.db.getBook(lastOpenedId);
        if (book) {
          this.openBook(book);
        }
      }
    } catch (err) {
      console.error('Initialization error:', err);
    }
  }

  loadSettings() {
    const saved = localStorage.getItem('lumina_reader_settings');
    if (saved) {
      try {
        this.settings = { ...this.settings, ...JSON.parse(saved) };
      } catch (e) {
        console.error('Could not parse settings:', e);
      }
    }
  }

  saveSettings() {
    localStorage.setItem('lumina_reader_settings', JSON.stringify(this.settings));
  }

  applySettings() {
    const root = document.documentElement;
    root.style.setProperty('--book-font', this.settings.fontFamily);
    root.style.setProperty('--book-font-size', `${this.settings.fontSize}px`);
    root.style.setProperty('--book-line-height', this.settings.lineHeight);
    root.style.setProperty('--book-content-width', `${this.settings.contentWidth}px`);
    root.style.setProperty('--book-text-align', this.settings.textAlign);

    // Apply Theme
    document.body.className = this.settings.theme;

    // Update typography drawer controls if bound
    if (this.dom && this.dom.fontSizeDisplay) {
      this.dom.fontSizeDisplay.textContent = `${this.settings.fontSize}px`;
      this.dom.fontSizeSlider.value = this.settings.fontSize;
      this.dom.lineHeightDisplay.textContent = this.settings.lineHeight;
      this.dom.lineHeightSlider.value = this.settings.lineHeight;
      this.dom.contentWidthDisplay.textContent = `${this.settings.contentWidth}px`;
      this.dom.contentWidthSlider.value = this.settings.contentWidth;

      // Update active font buttons
      document.querySelectorAll('.font-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.font === this.settings.fontFamily);
      });

      // Update active theme buttons
      document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === this.settings.theme);
      });

      // Update text align
      document.querySelectorAll('.align-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.align === this.settings.textAlign);
      });

      // Update format preset buttons
      const w = this.settings.contentWidth;
      document.querySelectorAll('.preset-btn').forEach(btn => {
        const p = btn.dataset.preset;
        const isActive = (p === 'novel' && w === 740) ||
                         (p === 'b5' && w === 860) ||
                         (p === 'a4' && w === 1050) ||
                         (p === 'wide' && w === 1350);
        btn.classList.toggle('active', isActive);
      });
    }
  }

  bindDOM() {
    this.dom = {
      sidebar: document.getElementById('sidebar'),
      toggleSidebarBtn: document.getElementById('toggleSidebarBtn'),
      closeSidebarBtn: document.getElementById('closeSidebarBtn'),
      dropZone: document.getElementById('dropZone'),
      fileInput: document.getElementById('pdfFileInput'),
      bookListContainer: document.getElementById('bookListContainer'),
      bookCountBadge: document.getElementById('bookCountBadge'),
      saveIndicator: document.getElementById('saveIndicator'),
      saveStatusText: document.getElementById('saveStatusText'),

      // Toolbar
      currentDocTitle: document.getElementById('currentDocTitle'),
      docProgressBadge: document.getElementById('docProgressBadge'),
      modeEnhancedBtn: document.getElementById('modeEnhancedBtn'),
      modeCanvasBtn: document.getElementById('modeCanvasBtn'),
      prevPageBtn: document.getElementById('prevPageBtn'),
      nextPageBtn: document.getElementById('nextPageBtn'),
      pageNumberInput: document.getElementById('pageNumberInput'),
      totalPagesSpan: document.getElementById('totalPagesSpan'),
      typographyPanelToggle: document.getElementById('typographyPanelToggle'),
      ttsPlayBtn: document.getElementById('ttsPlayBtn'),
      ttsBtnText: document.getElementById('ttsBtnText'),

      // Typography Drawer
      typographyDrawer: document.getElementById('typographyDrawer'),
      closeDrawerBtn: document.getElementById('closeDrawerBtn'),
      fontSizeSlider: document.getElementById('fontSizeSlider'),
      fontSizeDisplay: document.getElementById('fontSizeDisplay'),
      lineHeightSlider: document.getElementById('lineHeightSlider'),
      lineHeightDisplay: document.getElementById('lineHeightDisplay'),
      contentWidthSlider: document.getElementById('contentWidthSlider'),
      contentWidthDisplay: document.getElementById('contentWidthDisplay'),

      // Content View
      readerScrollArea: document.getElementById('readerScrollArea'),
      enhancedViewContainer: document.getElementById('enhancedViewContainer'),
      readingCard: document.getElementById('readingCard'),
      readingPageIndicator: document.getElementById('readingPageIndicator'),
      enhancedContent: document.getElementById('enhancedContent'),
      readingFooterNav: document.getElementById('readingFooterNav'),
      bottomPrevBtn: document.getElementById('bottomPrevBtn'),
      bottomNextBtn: document.getElementById('bottomNextBtn'),
      bottomPageStatus: document.getElementById('bottomPageStatus'),

      // Canvas
      canvasViewContainer: document.getElementById('canvasViewContainer'),
      pdfCanvas: document.getElementById('pdfCanvas'),
      zoomInBtn: document.getElementById('zoomInBtn'),
      zoomOutBtn: document.getElementById('zoomOutBtn'),
      zoomLevelDisplay: document.getElementById('zoomLevelDisplay'),
      fitWidthBtn: document.getElementById('fitWidthBtn'),

      // Mobile Specific Elements & Backdrops
      sidebarBackdrop: document.getElementById('sidebarBackdrop'),
      drawerBackdrop: document.getElementById('drawerBackdrop'),
      mobileBottomBar: document.getElementById('mobileBottomBar'),
      mobilePrevBtn: document.getElementById('mobilePrevBtn'),
      mobileNextBtn: document.getElementById('mobileNextBtn'),
      mobilePagePill: document.getElementById('mobilePagePill'),
      mobilePageDisplay: document.getElementById('mobilePageDisplay'),
      mobileTotalDisplay: document.getElementById('mobileTotalDisplay')
    };
  }

  bindEvents() {
    // Sidebar toggles & mobile backdrop
    const toggleSidebar = () => {
      if (window.innerWidth <= 900) {
        const isOpen = this.dom.sidebar.classList.toggle('mobile-open');
        this.dom.sidebarBackdrop?.classList.toggle('active', isOpen);
      } else {
        this.dom.sidebar.classList.toggle('collapsed');
      }
    };

    const closeMobileSidebar = () => {
      this.dom.sidebar.classList.remove('mobile-open');
      this.dom.sidebarBackdrop?.classList.remove('active');
    };

    this.dom.toggleSidebarBtn.addEventListener('click', toggleSidebar);
    this.dom.closeSidebarBtn?.addEventListener('click', closeMobileSidebar);
    this.dom.sidebarBackdrop?.addEventListener('click', closeMobileSidebar);

    // Typography Drawer Toggle & Backdrop
    const toggleDrawer = () => {
      const isOpen = this.dom.typographyDrawer.classList.toggle('open');
      this.dom.typographyPanelToggle.classList.toggle('active', isOpen);
      if (window.innerWidth <= 900) {
        this.dom.drawerBackdrop?.classList.toggle('active', isOpen);
      }
    };

    const closeDrawer = () => {
      this.dom.typographyDrawer.classList.remove('open');
      this.dom.typographyPanelToggle.classList.remove('active');
      this.dom.drawerBackdrop?.classList.remove('active');
    };

    this.dom.typographyPanelToggle.addEventListener('click', toggleDrawer);
    this.dom.closeDrawerBtn.addEventListener('click', closeDrawer);
    this.dom.drawerBackdrop?.addEventListener('click', closeDrawer);

    // Mobile Bottom Bar Navigation
    this.dom.mobilePrevBtn?.addEventListener('click', () => this.goToPage(this.currentPageNum - 1));
    this.dom.mobileNextBtn?.addEventListener('click', () => this.goToPage(this.currentPageNum + 1));
    this.dom.mobilePagePill?.addEventListener('click', () => {
      const target = prompt(`Lompat ke halaman (1 - ${this.totalPages}):`, this.currentPageNum);
      if (target !== null) {
        const num = parseInt(target, 10);
        if (!isNaN(num)) this.goToPage(num);
      }
    });

    // File Input & Drag and Drop
    this.dom.fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        const file = e.target.files[0];
        this.dom.fileInput.value = ''; // Reset so the same file can be selected again
        this.handleFileUpload(file);
      }
    });

    const dropZone = this.dom.dropZone;
    ['dragenter', 'dragover'].forEach(name => {
      dropZone.addEventListener(name, (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-active');
      });
    });
    ['dragleave', 'drop'].forEach(name => {
      dropZone.addEventListener(name, (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-active');
      });
    });
    dropZone.addEventListener('drop', (e) => {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        const file = e.dataTransfer.files[0];
        if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
          this.handleFileUpload(file);
        } else {
          alert('Mohon unggah file dengan format PDF.');
        }
      }
    });

    // Page navigation
    this.dom.prevPageBtn.addEventListener('click', () => this.goToPage(this.currentPageNum - 1));
    this.dom.nextPageBtn.addEventListener('click', () => this.goToPage(this.currentPageNum + 1));
    this.dom.bottomPrevBtn?.addEventListener('click', () => this.goToPage(this.currentPageNum - 1));
    this.dom.bottomNextBtn?.addEventListener('click', () => this.goToPage(this.currentPageNum + 1));

    this.dom.pageNumberInput.addEventListener('change', (e) => {
      const target = parseInt(e.target.value, 10);
      if (!isNaN(target)) {
        this.goToPage(target);
      }
    });

    // Keyboard Shortcuts (Arrow Left / Right)
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        this.goToPage(this.currentPageNum + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        this.goToPage(this.currentPageNum - 1);
      }
    });

    // View mode switchers
    this.dom.modeEnhancedBtn.addEventListener('click', () => this.setViewMode('enhanced'));
    this.dom.modeCanvasBtn.addEventListener('click', () => this.setViewMode('canvas'));



    // Font Options clicks
    document.querySelectorAll('.font-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.settings.fontFamily = btn.dataset.font;
        this.saveSettings();
        this.applySettings();
      });
    });

    // Theme Options clicks
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.settings.theme = btn.dataset.theme;
        this.saveSettings();
        this.applySettings();
      });
    });

    // Align buttons
    document.querySelectorAll('.align-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.settings.textAlign = btn.dataset.align;
        this.saveSettings();
        this.applySettings();
      });
    });

    // Preset Paper Sizes (Novel, B5, A4, Wide)
    const presetSizes = {
      novel: 740,
      b5: 860,
      a4: 1050,
      wide: 1350
    };
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        if (presetSizes[preset]) {
          this.settings.contentWidth = presetSizes[preset];
          this.saveSettings();
          this.applySettings();
        }
      });
    });

    // Sliders
    this.dom.fontSizeSlider.addEventListener('input', (e) => {
      this.settings.fontSize = parseInt(e.target.value, 10);
      this.saveSettings();
      this.applySettings();
    });

    this.dom.lineHeightSlider.addEventListener('input', (e) => {
      this.settings.lineHeight = parseFloat(e.target.value);
      this.saveSettings();
      this.applySettings();
    });

    this.dom.contentWidthSlider.addEventListener('input', (e) => {
      this.settings.contentWidth = parseInt(e.target.value, 10);
      this.saveSettings();
      this.applySettings();
    });

    // Canvas zoom
    this.dom.zoomInBtn.addEventListener('click', () => {
      this.zoomScale = Math.min(3.0, this.zoomScale + 0.2);
      this.dom.zoomLevelDisplay.textContent = `${Math.round(this.zoomScale * 100)}%`;
      if (this.viewMode === 'canvas') this.renderCanvasPage(this.currentPageNum);
    });

    this.dom.zoomOutBtn.addEventListener('click', () => {
      this.zoomScale = Math.max(0.6, this.zoomScale - 0.2);
      this.dom.zoomLevelDisplay.textContent = `${Math.round(this.zoomScale * 100)}%`;
      if (this.viewMode === 'canvas') this.renderCanvasPage(this.currentPageNum);
    });

    this.dom.fitWidthBtn.addEventListener('click', () => {
      this.zoomScale = 1.35;
      this.dom.zoomLevelDisplay.textContent = `135%`;
      if (this.viewMode === 'canvas') this.renderCanvasPage(this.currentPageNum);
    });

    // Text to Speech
    this.dom.ttsPlayBtn.addEventListener('click', () => {
      this.toggleTTS();
    });
  }

  /* ==========================================================================
     File Upload & Document Processing
     ========================================================================== */
  async handleFileUpload(file) {
    this.showSaveStatus('Sedang memuat & menyimpan buku...', true);

    try {
      const buffer = await file.arrayBuffer();
      // Store as Uint8Array for maximum IndexedDB compatibility across all browsers
      const uint8 = new Uint8Array(buffer);
      const id = `book_${encodeURIComponent(file.name)}_${file.size}`;

      const book = {
        id: id,
        title: file.name.replace(/\.[^/.]+$/, ''),
        data: uint8,
        size: file.size,
        currentPage: 1,
        totalPages: 1,
        lastReadDate: new Date().toLocaleDateString('id-ID')
      };

      try {
        await this.db.saveBook(book);
        await this.renderLibrary();
      } catch (dbErr) {
        console.warn('Gagal menyimpan ke IndexedDB (kuota penuh?), tetap membuka buku secara langsung:', dbErr);
      }

      await this.openBook(book);
      this.showSaveStatus('Tersimpan otomatis');
    } catch (err) {
      console.error('Error handling upload:', err);
      alert('Gagal membaca PDF: ' + (err.message || err));
      this.showSaveStatus('Gagal memuat');
    }
  }

  async openBook(book) {
    this.currentBook = book;
    localStorage.setItem('lumina_last_opened_id', book.id);
    this.cachePageTexts.clear();

    this.dom.currentDocTitle.textContent = book.title;
    this.dom.currentDocTitle.title = book.title;

    // Load PDF document using PDF.js
    try {
      this.showSaveStatus('Mempersiapkan buku...', true);
      
      // Make a fresh slice copy so transfer/worker detachment never corrupts book.data
      const pdfData = (book.data instanceof Uint8Array) 
        ? book.data.slice() 
        : new Uint8Array(book.data).slice();

      const loadingTask = pdfjsLib.getDocument({ 
        data: pdfData,
        cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
        cMapPacked: true
      });
      this.pdfDoc = await loadingTask.promise;
      this.totalPages = this.pdfDoc.numPages;

      // Update total pages in DB if not set
      if (book.totalPages !== this.totalPages) {
        book.totalPages = this.totalPages;
        try {
          await this.db.saveBook(book);
        } catch (e) {
          console.warn('Could not update total pages in DB:', e);
        }
      }

      this.dom.totalPagesSpan.textContent = this.totalPages;
      this.dom.pageNumberInput.max = this.totalPages;

      // Resume position saved in database!
      const resumePage = Math.min(Math.max(1, book.currentPage || 1), this.totalPages);
      this.currentPageNum = resumePage;

      await this.renderCurrentPage();
      this.updateProgressIndicator();
      this.renderLibrary(); // Re-render to show active item
      this.showSaveStatus(`Lanjut di Hal ${this.currentPageNum}`);

      // Close mobile sidebar and backdrop after book open
      this.dom.sidebar.classList.remove('mobile-open');
      this.dom.sidebarBackdrop?.classList.remove('active');
    } catch (err) {
      console.error('Error loading PDF document:', err);
      alert('Gagal membuka data PDF.');
    }
  }

  async renderLibrary() {
    const books = await this.db.getAllBooks();
    this.dom.bookCountBadge.textContent = `${books.length} buku`;

    if (books.length === 0) {
      this.dom.bookListContainer.innerHTML = `
        <div class="empty-library">
          <p>Belum ada buku yang tersimpan.</p>
          <small>PDF yang dibuka akan otomatis tersimpan posisi bacanya.</small>
        </div>
      `;
      return;
    }

    this.dom.bookListContainer.innerHTML = '';
    books.forEach(b => {
      const item = document.createElement('div');
      item.className = 'book-item' + (this.currentBook && this.currentBook.id === b.id ? ' active' : '');
      
      const pct = Math.round(((b.currentPage || 1) / (b.totalPages || 1)) * 100);

      item.innerHTML = `
        <div class="book-item-icon">📄</div>
        <div class="book-item-details">
          <div class="book-item-title" title="${b.title}">${b.title}</div>
          <div class="book-item-meta">
            <span>Hal ${b.currentPage || 1} / ${b.totalPages || 1}</span>
            <span>•</span>
            <span>${pct}%</span>
          </div>
        </div>
        <button class="book-delete-btn" title="Hapus buku dari riwayat">🗑</button>
      `;

      // Open book on click
      item.addEventListener('click', (e) => {
        if (e.target.closest('.book-delete-btn')) return;
        this.openBook(b);
      });

      // Delete book
      const deleteBtn = item.querySelector('.book-delete-btn');
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Hapus "${b.title}" dari perpustakaan?`)) {
          await this.db.deleteBook(b.id);
          if (this.currentBook && this.currentBook.id === b.id) {
            this.currentBook = null;
            this.pdfDoc = null;
            localStorage.removeItem('lumina_last_opened_id');
            this.showWelcomeScreen();
          }
          this.renderLibrary();
        }
      });

      this.dom.bookListContainer.appendChild(item);
    });
  }

  showWelcomeScreen() {
    this.dom.currentDocTitle.textContent = 'Belum ada buku dibuka';
    this.dom.docProgressBadge.textContent = '0% selesai';
    this.dom.pageNumberInput.value = 1;
    this.dom.totalPagesSpan.textContent = 1;
    this.dom.readingFooterNav.style.display = 'none';

    this.dom.enhancedContent.innerHTML = `
      <div class="welcome-guide">
        <div class="welcome-illustration">📖</div>
        <h2>Selamat Datang di LuminaRead!</h2>
        <p>Aplikasi pembaca PDF pintar yang mengubah dokumen kaku menjadi buku bacaan yang nyaman di mata.</p>
        <div class="feature-grid">
          <div class="feature-card">
            <span class="feature-icon">💾</span>
            <strong>Ingat Posisi Terakhir</strong>
            <p>Halaman dan progres bacaan Anda tersimpan otomatis. Buka kapan saja dan lanjutkan tepat di mana Anda berhenti.</p>
          </div>
          <div class="feature-card">
            <span class="feature-icon">✨</span>
            <strong>Koreksi Font & Style</strong>
            <p>Ubah jenis font dokumen dengan tipografi terkurasi (Lora, Merriweather, Inter) serta sesuaikan ukuran dan warna latar kertas.</p>
          </div>
          <div class="feature-card">
            <span class="feature-icon">📚</span>
            <strong>Perpustakaan Multi-Buku</strong>
            <p>Simpan banyak file PDF sekaligus dalam daftar riwayat lokal Anda tanpa khawatir hilang.</p>
          </div>
        </div>
        <div class="cta-box">
          <label for="pdfFileInput" class="btn-primary-large">
            Pilih File PDF untuk Mulai Membaca
          </label>
        </div>
      </div>
    `;
  }

  /* ==========================================================================
     Page Navigation & Progress Saving
     ========================================================================== */
  async goToPage(pageNum) {
    if (!this.pdfDoc) return;
    if (pageNum < 1 || pageNum > this.totalPages) return;

    this.currentPageNum = pageNum;
    await this.renderCurrentPage();

    // Persist position to IndexedDB
    if (this.currentBook) {
      this.currentBook.currentPage = this.currentPageNum;
      await this.db.updateProgress(this.currentBook.id, this.currentPageNum, this.totalPages);
      this.showSaveStatus(`Halaman ${this.currentPageNum} tersimpan`);
      this.updateProgressIndicator();
      this.renderLibrary(); // update page count in sidebar list
    }
  }

  updateProgressIndicator() {
    this.dom.pageNumberInput.value = this.currentPageNum;
    this.dom.prevPageBtn.disabled = this.currentPageNum <= 1;
    this.dom.nextPageBtn.disabled = this.currentPageNum >= this.totalPages;

    if (this.dom.bottomPrevBtn) this.dom.bottomPrevBtn.disabled = this.currentPageNum <= 1;
    if (this.dom.bottomNextBtn) this.dom.bottomNextBtn.disabled = this.currentPageNum >= this.totalPages;
    if (this.dom.bottomPageStatus) {
      this.dom.bottomPageStatus.textContent = `Halaman ${this.currentPageNum} dari ${this.totalPages}`;
    }

    const pct = Math.round((this.currentPageNum / this.totalPages) * 100);
    this.dom.docProgressBadge.textContent = `${pct}% selesai`;
    this.dom.readingPageIndicator.textContent = `Halaman ${this.currentPageNum} / ${this.totalPages}`;

    // Sync Mobile Bottom Bar
    if (this.dom.mobilePageDisplay) {
      this.dom.mobilePageDisplay.textContent = this.currentPageNum;
    }
    if (this.dom.mobileTotalDisplay) {
      this.dom.mobileTotalDisplay.textContent = this.totalPages;
    }
    if (this.dom.mobilePrevBtn) {
      this.dom.mobilePrevBtn.disabled = this.currentPageNum <= 1;
    }
    if (this.dom.mobileNextBtn) {
      this.dom.mobileNextBtn.disabled = this.currentPageNum >= this.totalPages;
    }
  }

  showSaveStatus(text, isLoading = false) {
    this.dom.saveStatusText.textContent = text;
    const dot = this.dom.saveIndicator.querySelector('.status-dot');
    if (dot) {
      dot.style.background = isLoading ? '#f59e0b' : '#10b981';
    }
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.dom.modeEnhancedBtn.classList.toggle('active', mode === 'enhanced');
    this.dom.modeCanvasBtn.classList.toggle('active', mode === 'canvas');

    if (mode === 'enhanced') {
      this.dom.enhancedViewContainer.style.display = 'flex';
      this.dom.canvasViewContainer.style.display = 'none';
      if (this.pdfDoc) this.renderEnhancedPage(this.currentPageNum);
    } else {
      this.dom.enhancedViewContainer.style.display = 'none';
      this.dom.canvasViewContainer.style.display = 'flex';
      if (this.pdfDoc) this.renderCanvasPage(this.currentPageNum);
    }
  }

  async renderCurrentPage() {
    // Scroll reader area back to top on page change
    this.dom.readerScrollArea.scrollTop = 0;

    if (this.viewMode === 'enhanced') {
      await this.renderEnhancedPage(this.currentPageNum);
    } else {
      await this.renderCanvasPage(this.currentPageNum);
    }
  }

  /* ==========================================================================
     Enhanced Typography Text Processing (Turning Raw PDF Text into Clean Book)
     ========================================================================== */
  async renderEnhancedPage(pageNum) {
    if (!this.pdfDoc) return;
    this.dom.readingFooterNav.style.display = 'flex';

    if (this.cachePageTexts.has(pageNum)) {
      this.dom.enhancedContent.innerHTML = this.cachePageTexts.get(pageNum);
      return;
    }

    this.dom.enhancedContent.innerHTML = `
      <div style="text-align: center; padding: 60px 0; color: var(--text-muted);">
        <p>Menata ulang tipografi novel halaman ${pageNum}...</p>
      </div>
    `;

    try {
      const page = await this.pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      const formattedHTML = await this.formatPDFTextIntoBook(textContent.items, page);
      this.cachePageTexts.set(pageNum, formattedHTML);
      this.dom.enhancedContent.innerHTML = formattedHTML;
    } catch (err) {
      console.error('Error extracting text from page:', err);
      this.dom.enhancedContent.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #ef4444;">
          <p>Halaman ini tidak memiliki teks atau berupa gambar.</p>
          <button id="fallbackCanvasBtn" class="btn-primary-large" style="margin-top: 15px; font-size: 0.85rem;">
            Lihat Format Asli PDF
          </button>
        </div>
      `;
      document.getElementById('fallbackCanvasBtn')?.addEventListener('click', () => {
        this.setViewMode('canvas');
      });
    }
  }

  /**
   * Intelligently groups text items by vertical position and font size.
   * Specifically optimized for Light Novels & eBooks:
   * - Filters out recurring watermarks, running headers, and page footers (e.g. "PDF by ruidrive", "PDF GS Vol 05")
   * - Detects and embeds illustration/cover pages automatically
   * - Styles dialogue and conversations cleanly
   * - Detects chapter titles and scene breaks
   */
  async formatPDFTextIntoBook(items, page) {
    // If page has almost no narrative text (illustrations, cover art, color pages)
    const validRawItems = (items || []).filter(item => {
      const s = (item.str || '').trim();
      if (!s) return false;
      if (/ruidrive|blogspot|PDF GS Vol|Qwer\s*\d+/i.test(s)) return false;
      return true;
    });

    if (validRawItems.length === 0) {
      // It's an illustration page! Render an embedded thumbnail/illustration directly!
      try {
        const viewport = page.getViewport({ scale: 1.5 });
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = viewport.width;
        offscreenCanvas.height = viewport.height;
        const ctx = offscreenCanvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        const imgUrl = offscreenCanvas.toDataURL('image/jpeg', 0.92);

        return `
          <div class="novel-illustration-wrapper">
            <img src="${imgUrl}" alt="Ilustrasi Novel" class="novel-illustration-img" />
            <span class="illustration-caption">Halaman Ilustrasi / Sampul Asli</span>
          </div>
        `;
      } catch (e) {
        return '<p class="empty-note">(Halaman Ilustrasi / Tanpa Teks)</p>';
      }
    }

    // Sort items by reading order (top to bottom, then left to right)
    const sorted = [...items].sort((a, b) => {
      const yDiff = b.transform[5] - a.transform[5];
      if (Math.abs(yDiff) > 4) {
        return yDiff;
      }
      return a.transform[4] - b.transform[4];
    });

    // Group items into lines
    const lines = [];
    let currentLine = { y: null, text: '', height: 0, fontName: '' };

    for (const item of sorted) {
      let text = item.str.trim();
      if (!text) continue;

      // Filter out watermark strings and running footers
      if (/ruidrive\.blogspot\.com|PDF GS Vol|Qwer\s*\d+|PDF by :? http/i.test(text)) {
        continue;
      }

      // Filter out lone page number header/footer numbers
      if (/^\d{1,4}$/.test(text)) {
        continue;
      }

      const y = item.transform[5];
      const height = Math.abs(item.height || item.transform[0]);

      if (currentLine.y === null) {
        currentLine = { y, text: item.str, height, fontName: item.fontName };
      } else if (Math.abs(currentLine.y - y) <= 4.8) {
        currentLine.text += (currentLine.text.endsWith(' ') || item.str.startsWith(' ') ? '' : ' ') + item.str;
        currentLine.height = Math.max(currentLine.height, height);
      } else {
        lines.push(currentLine);
        currentLine = { y, text: item.str, height, fontName: item.fontName };
      }
    }
    if (currentLine.text) {
      lines.push(currentLine);
    }

    if (lines.length === 0) {
      // If no valid reading lines, render as illustration page (like cover page / illustration)
      try {
        const viewport = page.getViewport({ scale: 1.5 });
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = viewport.width;
        offscreenCanvas.height = viewport.height;
        const ctx = offscreenCanvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        const imgUrl = offscreenCanvas.toDataURL('image/jpeg', 0.92);

        return `
          <div class="novel-illustration-wrapper">
            <img src="${imgUrl}" alt="Ilustrasi Novel" class="novel-illustration-img" />
            <span class="illustration-caption">Halaman Ilustrasi / Sampul Asli</span>
          </div>
        `;
      } catch (e) {
        return '<p class="empty-note">(Halaman Ilustrasi / Sampul)</p>';
      }
    }

    // Determine average line height to detect headings
    const avgHeight = lines.reduce((sum, l) => sum + l.height, 0) / lines.length;

    // Combine lines into logical paragraphs, dialogues, scene breaks
    const blocks = [];
    let currentBlock = { type: 'p', text: '' };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let trimmed = line.text.trim();
      if (!trimmed) continue;

      // Clean recurring OCR / font encoding artefacts
      trimmed = trimmed.replace(/\uFFFD/g, '-');

      // Detect scene break symbol (e.g. ◇◇◇◇, ***, ---)
      if (/^[◇◆■□★☆*~=-]{2,}$/.test(trimmed)) {
        if (currentBlock.text) {
          blocks.push(currentBlock);
          currentBlock = { type: 'p', text: '' };
        }
        blocks.push({ type: 'scene-break', text: '◆ ◆ ◆' });
        continue;
      }

      // Detect Chapter Titles or Section Titles (standalone short titles)
      const isChapterTitle = /^(Chapter\s+\d+|Prologue|Epilogue|Afterword|Short Story\s+\d+|Extra:?|List Chapter|Attention|Warning)/i.test(trimmed);
      const isHeading = isChapterTitle && trimmed.length < 80;

      if (isHeading) {
        if (currentBlock.text) {
          blocks.push(currentBlock);
        }
        blocks.push({
          type: 'h1',
          text: trimmed
        });
        currentBlock = { type: 'p', text: '' };
        continue;
      }

      // Check if line is dialogue starting with quotes
      const isDialogueStart = /^[“"『「]/.test(trimmed);

      // Check vertical gap to previous line
      const prevLine = lines[i - 1];
      const gap = prevLine ? Math.abs(prevLine.y - line.y) : 0;
      const isLargeGap = gap > Math.max(12, line.height * 2.1);

      if (isDialogueStart || isLargeGap) {
        if (currentBlock.text) {
          blocks.push(currentBlock);
        }
        currentBlock = {
          type: isDialogueStart ? 'dialogue' : 'p',
          text: trimmed
        };
      } else {
        if (!currentBlock.text) {
          currentBlock.text = trimmed;
        } else {
          // If previous ended with hyphen, join smoothly
          if (currentBlock.text.endsWith('-')) {
            currentBlock.text = currentBlock.text.slice(0, -1) + trimmed;
          } else {
            currentBlock.text += ' ' + trimmed;
          }
        }
      }
    }

    if (currentBlock.text) {
      blocks.push(currentBlock);
    }

    // Format to HTML
    return blocks.map(block => {
      const safeText = this.escapeHtml(block.text);
      if (block.type === 'h1') return `<h1 class="novel-chapter-title">${safeText}</h1>`;
      if (block.type === 'h2') return `<h2 class="novel-section-title">${safeText}</h2>`;
      if (block.type === 'scene-break') return `<div class="scene-divider"><span>${safeText}</span></div>`;
      if (block.type === 'dialogue') return `<p class="novel-dialogue">${safeText}</p>`;
      return `<p class="novel-narrative">${safeText}</p>`;
    }).join('\n');
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* ==========================================================================
     Original PDF Canvas Rendering Mode
     ========================================================================== */
  async renderCanvasPage(pageNum) {
    if (!this.pdfDoc) return;

    try {
      const page = await this.pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: this.zoomScale });

      const canvas = this.dom.pdfCanvas;
      const context = canvas.getContext('2d');
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      const renderContext = {
        canvasContext: context,
        viewport: viewport
      };

      await page.render(renderContext).promise;
    } catch (err) {
      console.error('Error rendering PDF canvas:', err);
    }
  }

  /* ==========================================================================
     Text-To-Speech (TTS) Narration
     ========================================================================== */
  toggleTTS() {
    if (!window.speechSynthesis) {
      alert('Browser Anda tidak mendukung fitur Text-to-Speech.');
      return;
    }

    if (this.isSpeaking) {
      window.speechSynthesis.cancel();
      this.isSpeaking = false;
      this.dom.ttsBtnText.textContent = 'Dengarkan';
      this.dom.ttsPlayBtn.classList.remove('active');
    } else {
      const text = this.dom.enhancedContent.innerText;
      if (!text || text.trim() === '') {
        alert('Tidak ada teks untuk dibaca pada halaman ini.');
        return;
      }

      this.speechUtterance = new SpeechSynthesisUtterance(text);
      this.speechUtterance.lang = 'id-ID'; // Indonesian default, falls back gracefully
      this.speechUtterance.rate = 1.0;

      this.speechUtterance.onend = () => {
        this.isSpeaking = false;
        this.dom.ttsBtnText.textContent = 'Dengarkan';
        this.dom.ttsPlayBtn.classList.remove('active');
      };

      this.speechUtterance.onerror = () => {
        this.isSpeaking = false;
        this.dom.ttsBtnText.textContent = 'Dengarkan';
        this.dom.ttsPlayBtn.classList.remove('active');
      };

      window.speechSynthesis.speak(this.speechUtterance);
      this.isSpeaking = true;
      this.dom.ttsBtnText.textContent = 'Hentikan';
      this.dom.ttsPlayBtn.classList.add('active');
    }
  }
}

// Instantiate application once DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.luminaReader = new LuminaReaderApp();
});
