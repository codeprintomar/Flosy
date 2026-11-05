/* =========================================================================
   Flosy — Student Money Manager
   Single-file offline app. All data lives in localStorage on this device.
   ========================================================================= */

const uid = () => 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

/* ---------------------------- Account (Firebase Auth) ---------------------------- */
// The "account" is now a real Firebase account (email/password). Data lives in
// Firestore under users/{uid} and syncs across any device the person logs into.
// A local copy is still cached in localStorage (smm_data_v1__<uid>) so the app
// still opens instantly and works offline; it's kept in sync with Firestore.
function getActiveProfileId() { return window.__uid || null; }
function storeKeyFor(id) { return 'smm_data_v1__' + id; }

/* ---------------------------- Default data ---------------------------- */
function defaultEnvelopes() {
  return [
    { id: 'env_books', key: 'books', icon: '📚', budget: 0, balance: 0, custom: false },
    { id: 'env_lessons', key: 'lessons', icon: '📝', budget: 0, balance: 0, custom: false },
    { id: 'env_personal', key: 'personal', icon: '👤', budget: 0, balance: 0, custom: false },
    { id: 'env_transport', key: 'transport', icon: '🚌', budget: 0, balance: 0, custom: false },
    { id: 'env_food', key: 'food', icon: '🍔', budget: 0, balance: 0, custom: false },
    { id: 'env_treats', key: 'treats', icon: '🍫', budget: 0, balance: 0, custom: false },
    { id: 'env_selfcare', key: 'selfcare', icon: '🧴', budget: 0, balance: 0, custom: false },
    { id: 'env_fun', key: 'entertainment', icon: '🎮', budget: 0, balance: 0, custom: false },
    { id: 'env_savings', key: 'savings', icon: '💾', budget: 0, balance: 0, custom: false },
  ];
}
function defaultWallets() {
  return [
    { id: 'wal_cash', key: 'cash', icon: '👛', custom: false },
    { id: 'wal_ewallet', key: 'ewallet', icon: '📱', custom: false },
    { id: 'wal_bank', key: 'bank', icon: '🏦', custom: false },
  ];
}
function freshState() {
  return {
    version: 1,
    settings: { currency: 'EGP', language: 'ar', theme: 'light', pin: null, biometric: false },
    wallets: defaultWallets(),
    envelopes: defaultEnvelopes(),
    transactions: [],
    books: [],
    lessons: [],
    savingsGoals: [],
    plannedExpenses: [],
    recurring: [],
    customCategories: [],
    incomeSources: [],
    quickAddButtons: [], // {id, icon, label, envelopeId, amount}
    owedToYou: [],       // {id, person, amount, date, note, returned}
    upcoming: [],        // {id, name, amount, date, note}
    cashDenominations: [], // {denomination, count} — tracks physical bills/coins on hand
    transportRoutes: [],   // {id, name, from, to, catId, roundTrip, legs:[{vehicle,price,label}], vehicle, price, icon}
    transportCategories: null, // [{id, name, icon}] — null until seeded with defaults
  };
}

let state = freshState();
function loadLocalCache(id) {
  try {
    const raw = localStorage.getItem(storeKeyFor(id));
    if (!raw) return null;
    return Object.assign(freshState(), JSON.parse(raw));
  } catch (e) { return null; }
}
// Pulls this account's data from Firestore (falling back to the local cache
// while offline), then keeps `state` in sync. Called right after login.
async function hydrateStateFromCloud(id) {
  const cached = loadLocalCache(id);
  if (cached) state = cached; // show cached data immediately, no spinner wait
  try {
    const cloudData = await window.FB.loadUserData(id);
    if (cloudData) {
      state = Object.assign(freshState(), cloudData);
      localStorage.setItem(storeKeyFor(id), JSON.stringify(state));
    } else {
      // brand-new account (or first login on this device with nothing synced yet)
      state = cached || freshState();
      await window.FB.saveUserData(id, state);
    }
  } catch (e) {
    // offline or Firestore unreachable — keep using the local cache silently
    if (!cached) state = freshState();
  }
}
let __saveDebounce = null;
function saveState() {
  const id = getActiveProfileId();
  if (!id) return;
  localStorage.setItem(storeKeyFor(id), JSON.stringify(state));
  if (!window.FB) return;
  clearTimeout(__saveDebounce);
  __saveDebounce = setTimeout(() => {
    window.FB.saveUserData(id, state).catch(() => { /* offline — local cache still has it, will resync on next save */ });
  }, 500);
}

/* -------------------- Offline receipt queue (IndexedDB) ------------------
   When a receipt photo can't be uploaded to Supabase (offline / error), we
   keep the raw file in IndexedDB — never as base64 in localStorage or
   Firestore — keyed by transaction id, and mark that transaction with
   receiptPendingLocal: true. flushPendingReceipts() retries them once we're
   back online. ------------------------------------------------------------- */
const RECEIPTS_IDB_NAME = 'flosy-pending-receipts';
function openReceiptsDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(RECEIPTS_IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('files'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function savePendingReceipt(transactionId, file) {
  const db = await openReceiptsDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put({ file, name: file.name, type: file.type }, transactionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function loadPendingReceipt(transactionId) {
  const db = await openReceiptsDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('files', 'readonly').objectStore('files').get(transactionId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function deletePendingReceipt(transactionId) {
  try {
    const db = await openReceiptsDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').delete(transactionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* non-fatal */ }
}
/** Try (re)uploading a single transaction's queued receipt to Supabase. */
async function uploadTransactionReceipt(tr, file) {
  const uploaded = await window.SB.uploadReceipt(window.__uid, tr.id, file);
  tr.receiptPath = uploaded.path;
  tr.receiptPendingLocal = false;
  saveState();
  await deletePendingReceipt(tr.id);
  return uploaded.path;
}
/** Called after login and whenever the browser comes back online. */
async function flushPendingReceipts() {
  if (!window.__uid || !window.SB) return;
  const pending = state.transactions.filter(tr => tr.receiptPendingLocal);
  for (const tr of pending) {
    try {
      const entry = await loadPendingReceipt(tr.id);
      if (!entry || !entry.file) { tr.receiptPendingLocal = false; continue; }
      await uploadTransactionReceipt(tr, entry.file);
    } catch (e) { /* still offline — leave queued, we'll retry next time */ }
  }
  render();
}
window.addEventListener('online', () => { flushPendingReceipts(); });

/* ------------------------------- i18n ---------------------------------- */
const STR = {
  ar: {
    appName: 'Flosy', dashboard: 'الرئيسية', envelopes: 'الأقسام', history: 'العمليات', reports: 'التقارير', more: 'المزيد',
    totalBalance: 'إجمالي رصيدك', available: 'متاح للصرف', reserved: 'محجوز', thisMonth: 'هذا الشهر',
    income: 'الدخل', expenses: 'المصروفات', savingLbl: 'التوفير', myEnvelopes: 'الأقسام', seeAll: 'عرض الكل',
    addMoney: 'إضافة فلوس', addExpense: 'تسجيل مصروف', quickActions: 'إجراءات سريعة',
    recentActivity: 'آخر العمليات', noTransactions: 'لا توجد عمليات بعد', noTransactionsSub: 'ابدأ بإضافة أول عملية لك',
    amount: 'المبلغ', source: 'المصدر', date: 'التاريخ', note: 'ملاحظة (اختياري)', wallet: 'المحفظة',
    category: 'القسم', description: 'الوصف', save: 'حفظ', cancel: 'إلغاء', splitAcrossEnvelopes: 'توزيع المبلغ على أكثر من قسم؟',
    splitTotal: 'إجمالي التوزيع', mustEqualAmount: 'يجب أن يساوي المبلغ الكلي', ok: 'مطابق ✓',
    allowance: 'مصروف', booksSrc: 'كتب', lessonsSrc: 'دروس', gift: 'هدية', work: 'شغل/فريلانس', other: 'أخرى',
    bonus: 'مكافأة', sale: 'بيع حاجة', refund: 'استرداد فلوس', interest: 'فوائد/أرباح',
    addIncomeSource: 'مصدر جديد', incomeSourceName: 'اسم المصدر', enterSourceName: 'اكتب اسم المصدر',
    transport: 'مواصلات', food: 'أكل', treats: 'حلويات', selfcare: 'العناية الشخصية', entertainment: 'ترفيه',
    savings: 'التوفير', personal: 'شخصي', books: 'الكتب', lessons: 'الدروس',
    addEnvelope: 'إضافة قسم جديد', envelopeName: 'اسم القسم', envelopeIcon: 'اختر أيقونة', budget: 'الميزانية الشهرية',
    used: 'المستخدم', remaining: 'المتبقي', envelopeDetail: 'تفاصيل القسم', editBudget: 'تعديل الميزانية',
    transfer: 'تحويل بين الأقسام', from: 'من', to: 'إلى', transferWallet: 'تحويل بين المحافظ',
    wallets: 'المحافظ', addWallet: 'إضافة محفظة', walletName: 'اسم المحفظة', totalAcrossWallets: 'الإجمالي عبر كل المحافظ',
    books_title: 'إدارة الكتب', addBook: 'إضافة كتاب', bookName: 'اسم الكتاب', expectedPrice: 'السعر المتوقع',
    amountReceived: 'المبلغ المستلم', amountPaid: 'المبلغ المدفوع', status: 'الحالة', pending: 'لم يُشترى بعد',
    partiallyPaid: 'مدفوع جزئيًا', paid: 'تم الشراء', difference: 'الفرق', whatHappenedDiff: 'الفرق ده هيروح فين؟',
    returned: 'رجّعته', addedPersonal: 'أضيفه لفلوسي الشخصية', keepBooks: 'يفضل فلوس كتب',
    lessons_title: 'إدارة الدروس', addLesson: 'إضافة درس', subject: 'المادة', teacher: 'المدرس',
    lessonPrice: 'سعر الدرس', paymentStatus: 'حالة الدفع', unpaid: 'لسه مدفوعش', upcoming: 'دروس قادمة',
    totalLessonsMoney: 'إجمالي فلوس الدروس', paidLbl: 'مدفوع', remainingLbl: 'متبقي',
    savingsGoals: 'أهداف التوفير', addGoal: 'هدف جديد', goalName: 'اسم الهدف', target: 'المبلغ المطلوب',
    current: 'الموفر حاليًا', deadline: 'الموعد المستهدف (اختياري)', priority: 'الأولوية', low: 'منخفضة', medium: 'متوسطة', high: 'عالية',
    addToGoal: 'إضافة توفير', plannedExpenses: 'مصاريف مستقبلية', addPlanned: 'مصروف مخطط جديد', planName: 'اسم المصروف',
    reserveMoney: 'احجز الفلوس دي', totalPlanned: 'إجمالي المخطط',
    whereIsMoney: 'فلوسي فين؟', canIBuy: 'أقدر أشتري ده؟', itemPrice: 'سعر الحاجة اللي عايز تشتريها',
    checkNow: 'اتأكد دلوقتي', canBuyYes: 'تقدر تشتريه 🟢', canBuyNo: 'مينفعش دلوقتي 🔴', canBuyTight: 'ممكن بس خد بالك 🟡',
    remainingAfter: 'المتبقي بعد الشراء', confirmPurchase: 'تأكيد الشراء كمصروف فعلي',
    searchPlaceholder: 'ابحث في العمليات...', all: 'الكل', today: 'اليوم', thisWeek: 'الأسبوع', thisMonthF: 'الشهر',
    incomeF: 'دخل', expenseF: 'مصروف', transferF: 'تحويل',
    monthlyReport: 'التقرير الشهري', incomeReport: 'تقرير الدخل', expenseReport: 'تقرير المصروفات',
    educationReport: 'تقرير الدراسة', savingsReport: 'تقرير التوفير', comparisonReport: 'مقارنة الشهور',
    netChange: 'صافي التغيير', highestCategory: 'أعلى قسم صرف', lowestCategory: 'أقل قسم صرف',
    avgDaily: 'متوسط الصرف اليومي', totalEducation: 'إجمالي مصاريف الدراسة',
    settingsLbl: 'الإعدادات', currencyLbl: 'العملة', languageLbl: 'اللغة', themeLbl: 'المظهر', dark: 'داكن', light: 'فاتح',
    pinLock: 'قفل PIN', backup: 'نسخة احتياطية', exportBackup: 'تصدير نسخة احتياطية', importBackup: 'استيراد نسخة احتياطية',
    exportTransactions: 'تصدير العمليات CSV', manageEnvelopes: 'إدارة الأقسام', manageWallets: 'إدارة المحافظ',
    smartAlerts: 'تنبيهات ذكية', noAlerts: 'كل حاجة تمام، مفيش تنبيهات دلوقتي 🎉',
    setPin: 'حدد رقم PIN مكون من 4 أرقام', confirmPin: 'أكد رقم الـ PIN', enterPin: 'ادخل رقم الـPIN',
    wrongPin: 'رقم غلط، حاول تاني', delete: 'حذف', edit: 'تعديل', savedSuccess: 'اتحفظ ✓', deletedSuccess: 'اتمسح ✓',
    receipt: 'صورة الإيصال (اختياري)', attachPhoto: 'إرفاق صورة', allocationTitle: 'وين توزّع الفلوس دي؟',
    removeReceipt: 'حذف الإيصال', retryUpload: 'إعادة محاولة الرفع', loadingReceipt: '...جاري تحميل الإيصال',
    receiptPendingNote: '⏳ الإيصال محفوظ على جهازك وهيترفع أول ما يرجع النت', receiptDeleteConfirm: 'تحذف صورة الإيصال دي؟',
    incomeSourcesChart: 'مصادر الدخل', expenseCategoriesChart: 'المصروفات حسب القسم',
    lastMonth: 'الشهر اللي فات', better: 'أحسن 🟢', same: 'زي بعضه 🟡', worse: 'أعلى صرف 🔴',
    weeklyReport: 'التقرير الأسبوعي', mostExpensiveDay: 'أغلى يوم', mostUsedCategory: 'أكتر قسم استخدام',
    activeGoals: 'أهداف شغالة', completedGoals: 'أهداف اتحققت', totalSaved: 'إجمالي الموفر',
    noEnvelopes: 'لسه مفيش أقسام', noBooks: 'لسه مفيش كتب مضافة', noLessons: 'لسه مفيش دروس مضافة',
    noGoals: 'لسه مفيش أهداف توفير', noPlanned: 'لسه مفيش مصاريف مخططة', addFirst: 'دوس على زر الإضافة تبدأ',
    numTransactions: 'عدد العمليات', highestExpense: 'أعلى مصروف', spendingHistory: 'سجل الصرف',
    resetApp: 'تصفير البيانات', resetConfirm: 'هل أنت متأكد؟ هيتمسح كل حاجة نهائيًا.',
    custom: 'مخصص', addCustomCategory: 'إضافة قسم مخصص', chooseIcon: 'اختر أيقونة', recurringSetup: 'أموال متكررة',
    frequency: 'التكرار', weekly: 'أسبوعيًا', monthly: 'شهريًا', activeToggle: 'مفعّل', dailySuggestion: 'المقترح اليومي للصرف',
    daysRemaining: 'الأيام المتبقية', good: 'ممتاز 🟢', careful: 'خليك حذر 🟡', warning: 'تنبيه 🔴',
    fromEnvelope: 'من قسم', toEnvelope: 'لإلى قسم', transferAmount: 'مبلغ التحويل', doTransfer: 'تنفيذ التحويل',
    fromWallet: 'من محفظة', toWallet: 'لمحفظة', notEnoughBalance: 'الرصيد في القسم ده مش كفاية',
    biometricLock: 'قفل بصمة (لو الجهاز بيدعمها)', appLocked: 'التطبيق مقفول', unlock: 'فتح',
    of: 'من', progress: 'التقدم', markPaid: 'اعتبره مدفوع بالكامل', receivedShort: 'مستلم',
    priceShort: 'السعر', dueDate: 'التاريخ', noReceipt: 'من غير صورة', months: ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'],
    version: 'رقم التطبيق', offlineNote: 'كل بياناتك متخزنة على جهازك بس، ومفيش حاجة بترفع لأي سيرفر.',
    envNames:{books:'الكتب',lessons:'الدروس',personal:'شخصي',transport:'مواصلات',food:'أكل',treats:'حلويات',selfcare:'العناية الشخصية',entertainment:'ترفيه',savings:'التوفير'},
    srcNames:{allowance:'مصروف',books:'كتب',lessons:'دروس',gift:'هدية',work:'شغل/فريلانس',other:'أخرى',bonus:'مكافأة',sale:'بيع حاجة',refund:'استرداد فلوس',interest:'فوائد/أرباح'},
    walNames:{cash:'كاش',ewallet:'محفظة إلكترونية',bank:'بنك'},
    close:'إغلاق', add:'إضافة', new:'جديد', total:'الإجمالي', name:'الاسم', icon:'الأيقونة',
    quickAddBtns: 'إجراءات سريعة مخصصة', addQuickAdd: 'إضافة زر سريع', editQuickAdd: 'تعديل الزر السريع',
    quickAddLabel: 'الاسم (مثال: مواصلات 8)', quickAddAmount: 'المبلغ', quickAddCategory: 'القسم',
    noQuickAdd: 'لسه مفيش أزرار سريعة', noQuickAddSub: 'اعمل أزرار للصروف اللي بتعملها كتير',
    confirmQuickAdd: 'تسجيل المصروف ده؟',
    monthlyReview: 'ملخص الشهر', startNewMonth: 'بدء شهر جديد',
    reviewIncome: 'دخلت', reviewExpense: 'صرفت', reviewSaved: 'وفرت',
    reviewTopCategory: 'أكثر فئة صرفًا', reviewComparison: 'أفضل من الشهر الماضي بنسبة',
    reviewNoChange: 'زي الشهر اللي فات',
    owedToYou: 'فلوس عند ناس', addOwed: 'إضافة فلوس عند شخص', owedPerson: 'اسم الشخص',
    owedAmount: 'المبلغ', owedDate: 'التاريخ', owedNote: 'ملاحظة (اختياري)',
    markReturned: 'رجع الفلوس', noOwed: 'لسه مفيش فلوس عند حد',
    upcomingMoney: 'فلوس قادمة', addUpcoming: 'إضافة فلوس قادمة', upcomingName: 'اسم المصروف',
    upcomingAmount: 'المبلغ', upcomingDate: 'التاريخ المتوقع', upcomingNote: 'ملاحظة (اختياري)',
    noUpcoming: 'لسه مفيش فلوس قادمة', markReceived: 'تم الاستلام',
    moneyTypes: 'أنواع الأموال', availableMoney: '💵 متاح للصرف', reservedMoney: '🔒 محجوز',
    owedMoney: '🤝 عند ناس', upcomingMoneyLbl: '📅 قادم', savingsMoney: '🏦 توفير',
    cashManager: 'إدارة الفكة', cashOnHand: '💵 الكاش الموجود', denomination: 'الفئة', count: 'العدد', total: 'الإجمالي',
    addDenomination: 'إضافة فئة', editDenominations: 'تعديل الفئات', smartPay: 'الدفع الذكي',
    payWithOptions: 'خيارات الدفع المتاحة:', change: 'الباقي', bestCombo: 'أفضل طريقة دفع',
    noDenominations: 'سجّل فئات الكش المعاك عشان نحسبلك الفكة',
    transportRoutes: 'طرق المواصلات', addRoute: 'إضافة طريق', editRoute: 'تعديل الطريق',
    routeName: 'اسم الطريق', fromLocation: 'من', toLocation: 'إلى', vehicleType: 'وسيلة النقل',
    routePrice: 'سعر الرحلة', logTrip: 'تسجيل الرحلة', noRoutes: 'لسه مفيش طرق مضافة',
    routesSub: 'اعمل طرقك وسجّل رحلاتك بضغطة واحدة',
    transportReport: 'تقرير المواصلات', totalTrips: 'إجمالي الرحلات', totalTransportSpent: 'إجمالي الصرف على المواصلات',
    mostUsedRoute: 'أكثر طريق استخدامًا', mostUsedVehicle: 'أكثر وسيلة استخدامًا',
    tripsThisMonth: 'رحلات هذا الشهر', vehicleStats: 'إحصائيات وسائل النقل',
    microbus: 'ميكروباص', bus: 'أتوبيس', train: 'قطار', taxi: 'تاكسي', uber: 'أوبر/ديدا', car: 'عربية',
  },
  en: {
    appName: 'Flosy', dashboard: 'Dashboard', envelopes: 'Envelopes', history: 'History', reports: 'Reports', more: 'More',
    totalBalance: 'Total Balance', available: 'Available', reserved: 'Reserved', thisMonth: 'This Month',
    income: 'Income', expenses: 'Expenses', savingLbl: 'Saved', myEnvelopes: 'Envelopes', seeAll: 'See all',
    addMoney: 'Add Money', addExpense: 'Add Expense', quickActions: 'Quick actions',
    recentActivity: 'Recent activity', noTransactions: 'No transactions yet', noTransactionsSub: 'Add your first transaction to get started',
    amount: 'Amount', source: 'Source', date: 'Date', note: 'Note (optional)', wallet: 'Wallet',
    category: 'Category', description: 'Description', save: 'Save', cancel: 'Cancel', splitAcrossEnvelopes: 'Split across envelopes?',
    splitTotal: 'Split total', mustEqualAmount: 'Must equal the total amount', ok: 'Matches ✓',
    allowance: 'Allowance', booksSrc: 'Books', lessonsSrc: 'Lessons', gift: 'Gift', work: 'Work/Freelance', other: 'Other',
    bonus: 'Bonus', sale: 'Sold something', refund: 'Refund', interest: 'Interest/Profit',
    addIncomeSource: 'New source', incomeSourceName: 'Source name', enterSourceName: 'Enter a source name',
    transport: 'Transportation', food: 'Food', treats: 'Treats', selfcare: 'Self Care', entertainment: 'Entertainment',
    savings: 'Savings', personal: 'Personal', books: 'Books', lessons: 'Lessons',
    addEnvelope: 'Add new envelope', envelopeName: 'Envelope name', envelopeIcon: 'Choose icon', budget: 'Monthly budget',
    used: 'Used', remaining: 'Remaining', envelopeDetail: 'Envelope details', editBudget: 'Edit budget',
    transfer: 'Transfer between envelopes', from: 'From', to: 'To', transferWallet: 'Transfer between wallets',
    wallets: 'Wallets', addWallet: 'Add wallet', walletName: 'Wallet name', totalAcrossWallets: 'Total across wallets',
    books_title: 'Books', addBook: 'Add book', bookName: 'Book name', expectedPrice: 'Expected price',
    amountReceived: 'Amount received', amountPaid: 'Amount paid', status: 'Status', pending: 'Pending',
    partiallyPaid: 'Partially paid', paid: 'Paid', difference: 'Difference', whatHappenedDiff: 'What happened to the difference?',
    returned: 'Returned', addedPersonal: 'Added to Personal Money', keepBooks: 'Still Books Money',
    lessons_title: 'Lessons', addLesson: 'Add lesson', subject: 'Subject', teacher: 'Teacher',
    lessonPrice: 'Lesson price', paymentStatus: 'Payment status', unpaid: 'Unpaid', upcoming: 'Upcoming lessons',
    totalLessonsMoney: 'Total lessons money', paidLbl: 'Paid', remainingLbl: 'Remaining',
    savingsGoals: 'Savings Goals', addGoal: 'New goal', goalName: 'Goal name', target: 'Target amount',
    current: 'Currently saved', deadline: 'Target date (optional)', priority: 'Priority', low: 'Low', medium: 'Medium', high: 'High',
    addToGoal: 'Add savings', plannedExpenses: 'Planned Expenses', addPlanned: 'New planned expense', planName: 'Expense name',
    reserveMoney: 'Reserve this money', totalPlanned: 'Total planned',
    whereIsMoney: 'Where Is My Money?', canIBuy: 'Can I Buy This?', itemPrice: 'Price of the item',
    checkNow: 'Check now', canBuyYes: 'You can buy it 🟢', canBuyNo: 'Not right now 🔴', canBuyTight: 'You could, be careful 🟡',
    remainingAfter: 'Remaining after purchase', confirmPurchase: 'Confirm as real purchase',
    searchPlaceholder: 'Search transactions...', all: 'All', today: 'Today', thisWeek: 'This week', thisMonthF: 'This month',
    incomeF: 'Income', expenseF: 'Expense', transferF: 'Transfer',
    monthlyReport: 'Monthly Report', incomeReport: 'Income Report', expenseReport: 'Expense Report',
    educationReport: 'Education Report', savingsReport: 'Savings Report', comparisonReport: 'Comparison Report',
    netChange: 'Net change', highestCategory: 'Highest spending', lowestCategory: 'Lowest spending',
    avgDaily: 'Average daily spending', totalEducation: 'Total education spending',
    settingsLbl: 'Settings', currencyLbl: 'Currency', languageLbl: 'Language', themeLbl: 'Theme', dark: 'Dark', light: 'Light',
    pinLock: 'PIN lock', backup: 'Backup', exportBackup: 'Export backup', importBackup: 'Import backup',
    exportTransactions: 'Export transactions CSV', manageEnvelopes: 'Manage envelopes', manageWallets: 'Manage wallets',
    smartAlerts: 'Smart alerts', noAlerts: 'All good, no alerts right now 🎉',
    setPin: 'Set a 4-digit PIN', confirmPin: 'Confirm PIN', enterPin: 'Enter PIN',
    wrongPin: 'Wrong PIN, try again', delete: 'Delete', edit: 'Edit', savedSuccess: 'Saved ✓', deletedSuccess: 'Deleted ✓',
    receipt: 'Receipt photo (optional)', attachPhoto: 'Attach photo', allocationTitle: 'Where should this go?',
    removeReceipt: 'Remove receipt', retryUpload: 'Retry upload', loadingReceipt: 'Loading receipt...',
    receiptPendingNote: "⏳ Saved on this device — will upload once you're back online", receiptDeleteConfirm: 'Delete this receipt photo?',
    incomeSourcesChart: 'Income sources', expenseCategoriesChart: 'Expenses by category',
    lastMonth: 'Last month', better: 'Better 🟢', same: 'Same 🟡', worse: 'Higher spending 🔴',
    weeklyReport: 'Weekly Report', mostExpensiveDay: 'Most expensive day', mostUsedCategory: 'Most used category',
    activeGoals: 'Active goals', completedGoals: 'Completed goals', totalSaved: 'Total saved',
    noEnvelopes: 'No envelopes yet', noBooks: 'No books added yet', noLessons: 'No lessons added yet',
    noGoals: 'No savings goals yet', noPlanned: 'No planned expenses yet', addFirst: 'Tap add to get started',
    numTransactions: 'Number of transactions', highestExpense: 'Highest expense', spendingHistory: 'Spending history',
    resetApp: 'Reset all data', resetConfirm: 'Are you sure? This will permanently delete everything.',
    custom: 'Custom', addCustomCategory: 'Add custom category', chooseIcon: 'Choose icon', recurringSetup: 'Recurring money',
    frequency: 'Frequency', weekly: 'Weekly', monthly: 'Monthly', activeToggle: 'Active', dailySuggestion: 'Suggested daily spending',
    daysRemaining: 'Days remaining', good: 'Good 🟢', careful: 'Be careful 🟡', warning: 'Warning 🔴',
    fromEnvelope: 'From envelope', toEnvelope: 'To envelope', transferAmount: 'Transfer amount', doTransfer: 'Transfer',
    fromWallet: 'From wallet', toWallet: 'To wallet', notEnoughBalance: "That envelope doesn't have enough balance",
    biometricLock: 'Biometric lock (if supported)', appLocked: 'App locked', unlock: 'Unlock',
    of: 'of', progress: 'Progress', markPaid: 'Mark as fully paid', receivedShort: 'Received',
    priceShort: 'Price', dueDate: 'Date', noReceipt: 'No photo', months: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
    version: 'Version', offlineNote: 'All your data stays on this device. Nothing is ever uploaded anywhere.',
    envNames:{books:'Books',lessons:'Lessons',personal:'Personal',transport:'Transportation',food:'Food',treats:'Treats',selfcare:'Self Care',entertainment:'Entertainment',savings:'Savings'},
    srcNames:{allowance:'Allowance',books:'Books',lessons:'Lessons',gift:'Gift',work:'Work/Freelance',other:'Other',bonus:'Bonus',sale:'Sold something',refund:'Refund',interest:'Interest/Profit'},
    walNames:{cash:'Cash',ewallet:'E-Wallet',bank:'Bank'},
    close:'Close', add:'Add', new:'New', total:'Total', name:'Name', icon:'Icon',
    quickAddBtns: 'Custom Quick Add', addQuickAdd: 'Add quick button', editQuickAdd: 'Edit quick button',
    quickAddLabel: 'Label (e.g. Bus 8)', quickAddAmount: 'Amount', quickAddCategory: 'Category',
    noQuickAdd: 'No quick buttons yet', noQuickAddSub: 'Create buttons for your frequent expenses',
    confirmQuickAdd: 'Log this expense?',
    monthlyReview: 'Monthly Review', startNewMonth: 'Start New Month',
    reviewIncome: 'Income', reviewExpense: 'Expenses', reviewSaved: 'Saved',
    reviewTopCategory: 'Top spending category', reviewComparison: 'Better than last month by',
    reviewNoChange: 'Same as last month',
    owedToYou: 'Owed to You', addOwed: 'Add money someone owes you', owedPerson: 'Person\'s name',
    owedAmount: 'Amount', owedDate: 'Date', owedNote: 'Note (optional)',
    markReturned: 'Mark as returned', noOwed: 'No money owed to you yet',
    upcomingMoney: 'Upcoming Money', addUpcoming: 'Add upcoming expense', upcomingName: 'Expense name',
    upcomingAmount: 'Amount', upcomingDate: 'Expected date', upcomingNote: 'Note (optional)',
    noUpcoming: 'No upcoming expenses yet', markReceived: 'Mark as received',
    moneyTypes: 'Money Types', availableMoney: '💵 Available', reservedMoney: '🔒 Reserved',
    owedMoney: '🤝 Owed to You', upcomingMoneyLbl: '📅 Upcoming', savingsMoney: '🏦 Savings',
    cashManager: 'Cash Manager', cashOnHand: '💵 Cash on Hand', denomination: 'Denomination', count: 'Count', total: 'Total',
    addDenomination: 'Add denomination', editDenominations: 'Edit denominations', smartPay: 'Smart Pay',
    payWithOptions: 'Payment options:', change: 'Change', bestCombo: 'Best payment combo',
    noDenominations: 'Track your bills and coins so we can calculate change for you',
    transportRoutes: 'Transport Routes', addRoute: 'Add route', editRoute: 'Edit route',
    routeName: 'Route name', fromLocation: 'From', toLocation: 'To', vehicleType: 'Vehicle',
    routePrice: 'Trip price', logTrip: 'Log trip', noRoutes: 'No routes added yet',
    routesSub: 'Create your routes and log trips with one tap',
    transportReport: 'Transport Report', totalTrips: 'Total trips', totalTransportSpent: 'Total transport spending',
    mostUsedRoute: 'Most used route', mostUsedVehicle: 'Most used vehicle',
    tripsThisMonth: 'Trips this month', vehicleStats: 'Vehicle statistics',
    microbus: 'Microbus', bus: 'Bus', train: 'Train', taxi: 'Taxi', uber: 'Uber/Careem', car: 'Car',
  }
};
function t(key) { return (STR[state.settings.language] || STR.ar)[key] ?? key; }
function envLabel(env) { return env.custom ? env.name : t('envNames')[env.key] || env.name || env.key; }
function walLabel(w) { return w.custom ? w.name : t('walNames')[w.key] || w.name || w.key; }

/* -------------------- Income sources (built-in + custom) -------------------- */
const BUILTIN_INCOME_SOURCES = ['allowance', 'books', 'lessons', 'gift', 'work', 'bonus', 'sale', 'refund', 'interest', 'other'];
const BUILTIN_SOURCE_ICONS = { allowance: '💵', books: '📚', lessons: '📝', gift: '🎁', work: '💼', bonus: '⭐', sale: '🏷️', refund: '↩️', interest: '📈', other: '📦' };
function allIncomeSources() { return [...BUILTIN_INCOME_SOURCES, ...((state.incomeSources || []).map(s => s.id))]; }
function customSourceById(id) { return (state.incomeSources || []).find(s => s.id === id); }
function sourceLabel(key) {
  const custom = customSourceById(key);
  if (custom) return custom.name;
  return t('srcNames')[key] || key;
}
function sourceIcon(key) {
  const custom = customSourceById(key);
  if (custom) return custom.icon || '💰';
  return BUILTIN_SOURCE_ICONS[key] || '💰';
}

/* ----------------------------- Formatting ------------------------------ */
function fmt(n) {
  const v = Math.round((n + Number.EPSILON) * 100) / 100;
  const s = v.toLocaleString(state.settings.language === 'ar' ? 'en-US' : 'en-US', { maximumFractionDigits: 2 });
  return s;
}
function money(n) { return `${fmt(n)} ${state.settings.currency}`; }
function signedMoney(n) { return `${n >= 0 ? '+' : ''}${fmt(n)} ${state.settings.currency}`; }

/* ------------------------------ Computations ---------------------------- */
function getEnvelope(id) { return state.envelopes.find(e => e.id === id); }
function getWallet(id) { return state.wallets.find(w => w.id === id); }

function totalIncome() { return state.transactions.filter(t => t.type === 'income').reduce((a, b) => a + b.amount, 0); }
function totalExpense() { return state.transactions.filter(t => t.type === 'expense').reduce((a, b) => a + b.amount, 0); }
function totalBalance() { return totalIncome() - totalExpense(); }
function reservedMoney() {
  const goalReserved = state.savingsGoals.reduce((a, g) => a + g.current, 0);
  const plannedReserved = state.plannedExpenses.filter(p => p.reserved).reduce((a, p) => a + p.amount, 0);
  return goalReserved + plannedReserved;
}
function availableMoney() { return totalBalance() - reservedMoney() - owedToYouTotal() - upcomingTotal(); }
function owedToYouTotal() { return (state.owedToYou || []).filter(o => !o.returned).reduce((a, b) => a + b.amount, 0); }
function upcomingTotal() { return (state.upcoming || []).reduce((a, b) => a + b.amount, 0); }
function savingsTotal() { return state.savingsGoals.reduce((a, g) => a + g.current, 0); }

function walletBalance(walletId) {
  let bal = 0;
  state.transactions.forEach(tr => {
    if (tr.type === 'income' && tr.walletId === walletId) bal += tr.amount;
    if (tr.type === 'expense' && tr.walletId === walletId) bal -= tr.amount;
    if (tr.type === 'walletTransfer') {
      if (tr.fromWalletId === walletId) bal -= tr.amount;
      if (tr.toWalletId === walletId) bal += tr.amount;
    }
  });
  return bal;
}
function totalAcrossWallets() { return state.wallets.reduce((a, w) => a + walletBalance(w.id), 0); }

function monthStart(offset = 0) {
  // always anchor on day 1 — setMonth() on the 29th-31st overflows into the next month
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - offset); return d;
}
function monthTx(offset = 0) {
  const d = monthStart(offset);
  const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  return state.transactions.filter(tr => String(tr.date || '').slice(0, 7) === key);
}
function monthIncome(offset = 0) { return monthTx(offset).filter(t => t.type === 'income').reduce((a, b) => a + b.amount, 0); }
function monthExpense(offset = 0) { return monthTx(offset).filter(t => t.type === 'expense').reduce((a, b) => a + b.amount, 0); }
function monthSaving(offset = 0) {
  return monthTx(offset).filter(t => t.type === 'envelopeTransfer' && t.toEnvelopeId === 'env_savings').reduce((a, b) => a + b.amount, 0)
    + monthTx(offset).filter(t => t.type === 'goalSave').reduce((a, b) => a + b.amount, 0);
}

function recalcEnvelopeBalances() {
  state.envelopes.forEach(e => e.balance = 0);
  state.transactions.forEach(tr => {
    if (tr.type === 'income' && tr.allocations) {
      tr.allocations.forEach(al => { const e = getEnvelope(al.envelopeId); if (e) e.balance += al.amount; });
    }
    if (tr.type === 'expense' && tr.envelopeId) {
      const e = getEnvelope(tr.envelopeId); if (e) e.balance -= tr.amount;
    }
    if (tr.type === 'envelopeTransfer') {
      const f = getEnvelope(tr.fromEnvelopeId); const to = getEnvelope(tr.toEnvelopeId);
      if (f) f.balance -= tr.amount; if (to) to.balance += tr.amount;
    }
  });
}

function envelopeSpent(envId, offset = 0) {
  return monthTx(offset).filter(t => t.type === 'expense' && t.envelopeId === envId).reduce((a, b) => a + b.amount, 0);
}

/* ------------------------------- Utilities ------------------------------ */
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}
function closeSheet() {
  document.getElementById('overlay').classList.remove('active');
  document.getElementById('sheet').innerHTML = '';
}
function openSheet(html) {
  document.getElementById('sheet').innerHTML = html;
  document.getElementById('overlay').classList.add('active');
}
document.addEventListener('click', (e) => { if (e.target.id === 'overlay') closeSheet(); });

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.settings.theme);
  document.body.setAttribute('dir', state.settings.language === 'ar' ? 'rtl' : 'ltr');
  document.body.setAttribute('lang', state.settings.language);
}

let currentScreen = 'dashboard';
function nav(screen) {
  currentScreen = screen;
  render();
  window.scrollTo(0, 0);
}

/* ============================== RENDER ROOT ============================== */
function render() {
  const app = document.getElementById('app');
  if (!getActiveProfileId()) { document.documentElement.removeAttribute('data-theme'); app.innerHTML = renderProfileGate(); return; }
  applyTheme();
  if (state.settings.pin && !window.__unlocked) { app.innerHTML = renderLockScreen(); return; }
  let body = '';
  if (currentScreen === 'dashboard') body = renderDashboard();
  else if (currentScreen === 'envelopes') body = renderEnvelopesScreen();
  else if (currentScreen === 'envelopeDetail') body = renderEnvelopeDetail(window.__envId);
  else if (currentScreen === 'history') body = renderHistory();
  else if (currentScreen === 'reports') body = renderReports();
  else if (currentScreen === 'more') body = renderMore();
  else if (currentScreen === 'books') body = renderBooks();
  else if (currentScreen === 'lessons') body = renderLessons();
  else if (currentScreen === 'wallets') body = renderWallets();
  else if (currentScreen === 'goals') body = renderGoals();
  else if (currentScreen === 'planned') body = renderPlanned();
  else if (currentScreen === 'whereIsMoney') body = renderWhereIsMoney();
  else if (currentScreen === 'canIBuy') body = renderCanIBuy();
  else if (currentScreen === 'settings') body = renderSettings();
  else if (currentScreen === 'alerts') body = renderAlertsScreen();
  else if (currentScreen === 'analytics') body = renderAnalytics();
  else if (currentScreen === 'quickAdd') body = renderQuickAdd();
  else if (currentScreen === 'monthlyReview') body = renderMonthlyReview();
  else if (currentScreen === 'manageQuickAdd') body = renderManageQuickAdd();
  else if (currentScreen === 'owedToYou') body = renderOwedToYou();
  else if (currentScreen === 'upcoming') body = renderUpcoming();
  else if (currentScreen === 'cashManager') body = renderCashManager();
  else if (currentScreen === 'transportRoutes') body = renderTransportRoutes();
  else if (currentScreen === 'transportReport') body = renderTransportReport();

  app.innerHTML = `
    <div class="topbar">
      <div>
        <h1>${screenTitle()}</h1>
      </div>
      <div class="topbar-actions">
        ${currentScreen === 'dashboard' ? `<button class="icon-btn" onclick="nav('alerts')">🔔</button><button class="icon-btn" onclick="nav('settings')">⚙️</button>` :
          `<button class="icon-btn" onclick="nav('dashboard')">${state.settings.language==='ar'?'✕':'✕'}</button>`}
      </div>
    </div>
    <div class="screen active">${body}</div>
    ${renderBottomNav()}
  `;
  runDeferredCharts();
}

function screenTitle() {
  const map = { dashboard: t('appName'), envelopes: t('envelopes'), envelopeDetail: t('envelopeDetail'), history: t('history'),
    reports: t('reports'), more: t('more'), books: t('books_title'), lessons: t('lessons_title'), wallets: t('wallets'),
    goals: t('savingsGoals'), planned: t('plannedExpenses'), whereIsMoney: t('whereIsMoney'), canIBuy: t('canIBuy'),
    settings: t('settingsLbl'), alerts: t('smartAlerts'),
    analytics: state.settings.language==='ar'?'التحليلات الذكية':'Smart Analytics',
    quickAdd: state.settings.language==='ar'?'إضافة سريعة ✨':'Quick Add ✨',
    monthlyReview: t('monthlyReview'),
    manageQuickAdd: t('quickAddBtns'),
    owedToYou: t('owedToYou'),
    upcoming: t('upcomingMoney'),
    cashManager: t('cashManager'),
    transportRoutes: t('transportRoutes'),
    transportReport: t('transportReport') };
  return map[currentScreen] || t('appName');
}

function renderBottomNav() {
  const items = [
    { id: 'dashboard', ic: '🏠', lb: t('dashboard') },
    { id: 'envelopes', ic: '🪣', lb: t('envelopes') },
    { id: 'history', ic: '📜', lb: t('history') },
    { id: 'reports', ic: '📊', lb: t('reports') },
    { id: 'more', ic: '⋯', lb: t('more') },
  ];
  return `<div class="bottom-nav">${items.map(i => `
    <button class="nav-btn ${currentScreen===i.id?'active':''}" onclick="nav('${i.id}')">
      <div class="ic">${i.ic}</div><div class="lb">${i.lb}</div>
    </button>`).join('')}</div>`;
}

/* ============================== AUTH GATE (Firebase account) ============================== */
window.__authMode = 'login';
window.__authBusy = false;
function renderProfileGate() {
  if (!window.FB) {
    return `
    <div style="min-height:100vh; display:flex; flex-direction:column; justify-content:center; align-items:center; padding:26px 22px; text-align:center;">
      <div style="font-size:44px;">📡</div>
      <h2 style="margin:10px 0 4px;">تعذّر الاتصال بخدمة الحساب</h2>
      <p class="small-note">تأكد إن جهازك متصل بالإنترنت وحدّث الصفحة.<br>Couldn't reach the account service — check your connection and refresh.</p>
    </div>`;
  }
  const mode = window.__authMode;
  const redirectErr = window.__googleRedirectError;
  window.__googleRedirectError = null; // show it once
  return `
  <div style="min-height:100vh; display:flex; flex-direction:column; justify-content:center; padding:32px 22px; max-width:520px; margin:0 auto;">
    <div style="text-align:center; margin-bottom:26px;">
      <div style="width:76px; height:76px; margin:0 auto 14px; border-radius:22px; display:flex; align-items:center; justify-content:center; font-size:38px;
                  background:linear-gradient(155deg, var(--primary) 0%, var(--primary-2) 100%); box-shadow:var(--shadow);">💸</div>
      <h2 style="margin:0 0 4px; font-size:24px; font-weight:900; letter-spacing:-.3px;">Flosy</h2>
      <p class="small-note">بياناتك محفوظة في حسابك وتقدر تدخل بيه من أي جهاز.<br>Your data is saved to your account and syncs across devices.</p>
    </div>
    <div class="card" style="padding:18px;">
      <div class="seg" style="margin-bottom:16px;">
        <button class="${mode==='login'?'active':''}" onclick="setAuthMode('login')">دخول</button>
        <button class="${mode==='signup'?'active':''}" onclick="setAuthMode('signup')">حساب جديد</button>
      </div>
      ${mode==='signup' ? `<div class="form-group"><label>اسمك</label><input type="text" id="authName" placeholder="مثلاً: عمر"></div>` : ''}
      <div class="form-group"><label>البريد الإلكتروني</label><input type="text" id="authEmail" placeholder="you@example.com" autocomplete="email"></div>
      <div class="form-group">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:5px;">
          <label style="margin:0;">كلمة المرور</label>
          ${mode==='login' ? `<button type="button" onclick="openForgotPassword()" style="background:none;border:none;padding:0;font-size:11.5px;font-weight:700;color:var(--primary-2);cursor:pointer;">نسيت كلمة السر؟</button>` : ''}
        </div>
        <input type="password" id="authPassword" placeholder="6 حروف على الأقل" autocomplete="${mode==='login'?'current-password':'new-password'}">
      </div>
      <button class="btn btn-primary" id="authSubmitBtn" onclick="submitAuth()">${mode==='login' ? '🔑 دخول' : '➕ إنشاء الحساب'}</button>
      <div style="display:flex; align-items:center; gap:10px; margin:16px 0;">
        <div style="flex:1; height:1px; background:var(--line);"></div>
        <span class="small-note">أو</span>
        <div style="flex:1; height:1px; background:var(--line);"></div>
      </div>
      <button class="btn btn-outline" id="googleAuthBtn" onclick="submitGoogleAuth()" style="gap:9px;">
        <svg width="18" height="18" viewBox="0 0 18 18" style="flex-shrink:0;">
          <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"/>
          <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.95v2.33A9 9 0 0 0 9 18z"/>
          <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.95A9 9 0 0 0 0 9c0 1.45.35 2.83.95 4.03l3-2.33z"/>
          <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .95 4.97l3 2.33C4.66 5.17 6.65 3.58 9 3.58z"/>
        </svg>
        <span>دخول بحساب Google</span>
      </button>
      <div id="authError" class="small-note" style="color:var(--bad); margin-top:10px; text-align:center; min-height:16px;">${redirectErr ? authErrorMessage(redirectErr) : ''}</div>
    </div>
  </div>`;
}
async function submitGoogleAuth() {
  if (window.__authBusy) return;
  const errEl = document.getElementById('authError');
  if (errEl) errEl.textContent = '';
  window.__authBusy = true;
  const btn = document.getElementById('googleAuthBtn');
  const btnLabel = btn ? btn.querySelector('span:last-child') : null;
  if (btn) { btn.disabled = true; if (btnLabel) btnLabel.textContent = '...جاري الدخول'; }
  try {
    await window.FB.signInWithGoogle();
    // Either window.FB.onAuthChange listener takes it from here (popup path),
    // or the page is about to navigate away for the redirect fallback.
  } catch (e) {
    if (errEl) errEl.textContent = authErrorMessage(e);
    window.__authBusy = false;
    if (btn) { btn.disabled = false; if (btnLabel) btnLabel.textContent = 'دخول بحساب Google'; }
  }
}
function setAuthMode(m) { window.__authMode = m; render(); }
function openForgotPassword() {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>استرجاع كلمة السر</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <p class="small-note" style="margin-bottom:14px;">اكتب بريدك الإلكتروني وهنبعتلك لينك لتغيير كلمة السر.</p>
    <div class="form-group"><label>البريد الإلكتروني</label><input type="text" id="resetEmail" placeholder="you@example.com" autocomplete="email"></div>
    <button class="btn btn-primary" id="resetSubmitBtn" onclick="submitForgotPassword()">إرسال لينك الاسترجاع</button>
    <div id="resetError" class="small-note" style="color:var(--bad); margin-top:10px; text-align:center; min-height:16px;"></div>
  `);
}
async function submitForgotPassword() {
  const email = (document.getElementById('resetEmail')||{}).value?.trim() || '';
  const errEl = document.getElementById('resetError');
  if (errEl) errEl.textContent = '';
  if (!email) { if (errEl) errEl.textContent = 'اكتب البريد الإلكتروني الأول'; return; }
  const btn = document.getElementById('resetSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = '...جاري الإرسال'; }
  try {
    await window.FB.sendPasswordReset(email);
    closeSheet();
    toast('اتبعت لينك استرجاع كلمة السر على بريدك 📩');
  } catch (e) {
    if (errEl) errEl.textContent = authErrorMessage(e);
    if (btn) { btn.disabled = false; btn.textContent = 'إرسال لينك الاسترجاع'; }
  }
}
async function submitAuth() {
  if (window.__authBusy) return;
  const email = (document.getElementById('authEmail')||{}).value?.trim() || '';
  const password = (document.getElementById('authPassword')||{}).value || '';
  const errEl = document.getElementById('authError');
  if (errEl) errEl.textContent = '';
  if (!email || !password) { if (errEl) errEl.textContent = 'اكتب البريد وكلمة المرور'; return; }
  window.__authBusy = true;
  const btn = document.getElementById('authSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = '...جاري الدخول'; }
  try {
    if (window.__authMode === 'signup') {
      const name = (document.getElementById('authName')||{}).value?.trim() || '';
      await window.FB.signUp(email, password, name);
    } else {
      await window.FB.signIn(email, password);
    }
    // window.FB.onAuthChange listener (registered on load) takes it from here.
  } catch (e) {
    if (errEl) errEl.textContent = authErrorMessage(e);
    window.__authBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = window.__authMode==='login' ? '🔑 دخول' : '➕ إنشاء الحساب'; }
  }
}
function authErrorMessage(e) {
  const code = (e && e.code) || '';
  const map = {
    'auth/email-already-in-use': 'البريد ده متسجل بحساب قبل كده — جرب "دخول" بدل إنشاء حساب.',
    'auth/invalid-email': 'البريد الإلكتروني مش صحيح.',
    'auth/weak-password': 'كلمة المرور لازم تكون 6 حروف على الأقل.',
    'auth/user-not-found': 'مفيش حساب بالبريد ده.',
    'auth/wrong-password': 'كلمة المرور غلط.',
    'auth/invalid-credential': 'البريد أو كلمة المرور غلط.',
    'auth/too-many-requests': 'محاولات كتير غلط — جرب تاني بعد شوية.',
    'auth/network-request-failed': 'مفيش اتصال بالإنترنت.',
    'auth/popup-closed-by-user': 'قفلت نافذة الدخول بجوجل قبل ما تكمّل.',
    'auth/popup-blocked': 'المتصفح مَنَع نافذة الدخول — اسمح بالنوافذ المنبثقة وجرب تاني.',
    'auth/account-exists-with-different-credential': 'الإيميل ده متسجل بطريقة دخول تانية (باسورد مثلاً) — جرب تدخل بيها.',
    'auth/unauthorized-domain': 'الدومين ده مش مسموح له بالدخول عن طريق Google — لازم يتضاف في Firebase Console ← Authentication ← Settings ← Authorized domains.',
    'auth/operation-not-allowed': 'الدخول بحساب Google مش مفعّل في المشروع — فعّله من Firebase Console ← Authentication ← Sign-in method.',
    'auth/user-disabled': 'الحساب ده متعطّل.',
    'auth/credential-already-in-use': 'حساب Google ده مربوط بحساب Flosy تاني. استخدم حساب Google مختلف.',
    'auth/provider-already-linked': 'حساب Google مربوط بالفعل.',
    'auth/requires-recent-login': 'سجّل خروج وادخل تاني وبعدين جرب الربط.',
    'auth/cancelled-popup-request': 'اتلغت نافذة الدخول، جرب تاني.',
    'auth/web-storage-unsupported': 'المتصفح بيمنع التخزين — فعّل الكوكيز أو افتح اللينك في متصفح عادي.',
  };
  return map[code] || 'حصل خطأ، جرب تاني.';
}
function switchProfile() {
  if (!confirm('هتسجّل خروج من حسابك على الجهاز ده؟')) return;
  window.FB.signOutUser();
  // window.FB.onAuthChange listener will reset `state` and show the auth gate.
}

/* ============================== LOCK SCREEN ============================== */
window.__pinBuffer = '';
function renderLockScreen() {
  return `
  <div style="min-height:100vh; display:flex; flex-direction:column; justify-content:center; align-items:center; padding:20px;">
    <div style="font-size:44px; margin-bottom:6px;">🔒</div>
    <h2 style="margin:0 0 4px;">${t('appLocked')}</h2>
    <p class="small-note">${t('enterPin')}</p>
    <div class="pin-dots">${[0,1,2,3].map(i=>`<div class="pin-dot ${window.__pinBuffer.length>i?'filled':''}"></div>`).join('')}</div>
    <div class="pin-pad">
      ${[1,2,3,4,5,6,7,8,9].map(n=>`<button class="pin-key" onclick="pinPress('${n}')">${n}</button>`).join('')}
      <div></div><button class="pin-key" onclick="pinPress('0')">0</button>
      <button class="pin-key" onclick="pinPress('back')">⌫</button>
    </div>
  </div>`;
}
function pinPress(k) {
  if (k === 'back') { window.__pinBuffer = window.__pinBuffer.slice(0, -1); render(); return; }
  if (window.__pinBuffer.length >= 4) return;
  window.__pinBuffer += k;
  render();
  if (window.__pinBuffer.length === 4) {
    setTimeout(() => {
      if (window.__pinBuffer === state.settings.pin) { window.__unlocked = true; window.__pinBuffer=''; render(); }
      else { toast(t('wrongPin')); window.__pinBuffer = ''; render(); }
    }, 150);
  }
}

/* ============================== DASHBOARD ============================== */
function renderDashboard() {
  recalcEnvelopeBalances();
  const alerts = computeAlerts();
  const tb = totalBalance(), av = availableMoney(), rv = reservedMoney();
  const otu = owedToYouTotal(), upc = upcomingTotal(), sav = savingsTotal();
  const mi = monthIncome(), me = monthExpense(), ms = monthSaving();
  const recent = [...state.transactions].sort((a,b)=> (b.createdAt||0)-(a.createdAt||0)).slice(0,6);
  const qabs = state.quickAddButtons || [];

  return `
    <div class="hero">
      <div class="label">${t('totalBalance')}</div>
      <div class="amount">${money(tb)}</div>
      <div class="hero-row">
        <div class="hero-chip"><div class="l">💵 ${t('available')}</div><div class="v">${money(av)}</div></div>
        <div class="hero-chip"><div class="l">🔒 ${t('reserved')}</div><div class="v">${money(rv)}</div></div>
      </div>
      <div class="hero-row" style="margin-top:8px;">
        <div class="hero-chip"><div class="l">🤝 ${t('owedMoney')}</div><div class="v">${money(otu)}</div></div>
        <div class="hero-chip"><div class="l">📅 ${t('upcomingMoneyLbl')}</div><div class="v">${money(upc)}</div></div>
        <div class="hero-chip"><div class="l">🏦 ${t('savingsMoney')}</div><div class="v">${money(sav)}</div></div>
      </div>
    </div>

    <div class="section-head"><h2>${t('thisMonth')}</h2><button class="link" onclick="nav('analytics')">🔮 ${state.settings.language==='ar'?'التحليلات':'Analytics'}</button></div>
    <div class="month-row">
      <div class="month-card income"><div class="v">${fmt(mi)}</div><div class="l">${t('income')}</div></div>
      <div class="month-card expense"><div class="v">${fmt(me)}</div><div class="l">${t('expenses')}</div></div>
      <div class="month-card saving"><div class="v">${fmt(ms)}</div><div class="l">${t('savingLbl')}</div></div>
    </div>

    <div class="fab-row">
      <button class="btn btn-primary" onclick="openAddMoneySheet()">➕ ${t('addMoney')}</button>
      <button class="btn btn-outline" onclick="openAddExpenseSheet()">➖ ${t('addExpense')}</button>
    </div>
    <div class="fab-row" style="margin-top:8px;">
      <button class="btn btn-accent" onclick="nav('quickAdd')">✨ ${state.settings.language==='ar'?'اكتب مصروفك بجملة واحدة':'Type your expense in one line'}</button>
    </div>

    ${qabs.length > 0 ? `
    <div class="section-head"><h2>⚡ ${t('quickActions')}</h2><button class="link" onclick="nav('manageQuickAdd')">⚙️</button></div>
    <div class="quick-add-grid">${qabs.map(q => `
      <button class="quick-add-btn" onclick="executeQuickAdd('${q.id}')">
        <span class="qa-icon">${q.icon}</span>
        <span class="qa-label">${q.label}</span>
        <span class="qa-amount">${fmt(q.amount)} ${state.settings.currency}</span>
      </button>`).join('')}
    </div>` : ''}

    ${alerts.length ? `
    <div class="section-head"><h2>${t('smartAlerts')}</h2><button class="link" onclick="nav('alerts')">${t('seeAll')}</button></div>
    ${alerts.slice(0,2).map(alertCardHtml).join('')}` : ''}

    <div class="section-head"><h2>${t('myEnvelopes')}</h2><button class="link" onclick="nav('envelopes')">${t('seeAll')}</button></div>
    <div class="env-grid">${state.envelopes.slice(0,6).map(envCardHtml).join('')}</div>

    <div class="section-head"><h2>${t('recentActivity')}</h2><button class="link" onclick="nav('history')">${t('seeAll')}</button></div>
    ${recent.length === 0 ? emptyState('📭', t('noTransactions'), t('noTransactionsSub')) :
      `<div class="card">${recent.map(txRowHtml).join('')}</div>`}
  `;
}

function envCardHtml(e) {
  const pct = e.budget > 0 ? Math.min(100, Math.round((envelopeSpent(e.id) / e.budget) * 100)) : 0;
  const color = pct >= 90 ? 'var(--bad)' : pct >= 70 ? 'var(--accent)' : 'var(--primary-2)';
  return `
  <div class="env-card" onclick="openEnvelopeDetail('${e.id}')">
    <div class="top"><span class="ico">${e.icon}</span></div>
    <div class="name">${envLabel(e)}</div>
    <div class="amt">${money(e.balance)}</div>
    ${e.budget > 0 ? `<div class="progress-track"><div class="progress-fill" style="width:${pct}%; background:${color}"></div></div>
    <div class="budget-line">${fmt(envelopeSpent(e.id))} / ${fmt(e.budget)}</div>` : ''}
  </div>`;
}

function emptyState(ico, tt, sub) {
  return `<div class="empty-state"><div class="e-ico">${ico}</div><div class="e-t">${tt}</div><div class="e-s">${sub}</div></div>`;
}

function txIcon(tr) {
  if (tr.type === 'income') return '⬇️';
  if (tr.type === 'expense') { const e = getEnvelope(tr.envelopeId); return e ? e.icon : '💸'; }
  if (tr.type === 'envelopeTransfer' || tr.type === 'walletTransfer') return '🔄';
  if (tr.type === 'goalSave') return '🎯';
  return '💰';
}
function txTitle(tr) {
  if (tr.type === 'income') return `${t('addMoney')} — ${sourceLabel(tr.source)}`;
  if (tr.type === 'expense') { const e = getEnvelope(tr.envelopeId); return tr.description || (e ? envLabel(e) : t('expenses')); }
  if (tr.type === 'envelopeTransfer') { const f=getEnvelope(tr.fromEnvelopeId), to=getEnvelope(tr.toEnvelopeId); return `${f?envLabel(f):''} → ${to?envLabel(to):''}`; }
  if (tr.type === 'walletTransfer') { const f=getWallet(tr.fromWalletId), to=getWallet(tr.toWalletId); return `${f?walLabel(f):''} → ${to?walLabel(to):''}`; }
  if (tr.type === 'goalSave') { const g = state.savingsGoals.find(x=>x.id===tr.goalId); return `🎯 ${g?g.name:''}`; }
  return tr.note || '';
}
function txRowHtml(tr) {
  const sign = tr.type === 'income' ? 'pos' : (tr.type === 'expense' || tr.type === 'goalSave') ? 'neg' : 'neu';
  const amt = (tr.type === 'income') ? `+${fmt(tr.amount)}` : (tr.type === 'expense' || tr.type === 'goalSave') ? `-${fmt(tr.amount)}` : fmt(tr.amount);
  return `
  <div class="list-row">
    <div class="ico-badge">${txIcon(tr)}</div>
    <div class="mid"><div class="t1">${txTitle(tr)}</div><div class="t2">${tr.date}${tr.walletId? ' · '+walLabel(getWallet(tr.walletId)||{}):''}</div></div>
    <div class="amt ${sign}">${amt} ${state.settings.currency}</div>
  </div>`;
}
function alertCardHtml(a) {
  return `<div class="alert-card ${a.level}"><div>${a.ico}</div><div class="t">${a.text}</div></div>`;
}

/* ============================== ALERTS ============================== */
function computeAlerts() {
  const alerts = [];
  const isAr = state.settings.language === 'ar';
  const dom = dayOfMonth(), dim = daysInCurrentMonth(), daysLeft = dim - dom;
  state.envelopes.forEach(e => {
    if (e.budget > 0) {
      const spent = envelopeSpent(e.id);
      const pct = spent / e.budget;
      const dailyRate = dom > 0 ? spent / dom : 0;
      const projectedTotal = dailyRate * dim;
      if (pct >= 1) alerts.push({ level: 'danger', ico: '🔴', text: `${envLabel(e)} — ${t('warning')}: ${Math.round(pct*100)}%` });
      else if (pct >= 0.8) alerts.push({ level: 'warn', ico: '⚠️', text: isAr
        ? `صرفت ${Math.round(pct*100)}% من ميزانية ${envLabel(e)}، وباقي ${daysLeft} يوم في الشهر.`
        : `You've used ${Math.round(pct*100)}% of your ${envLabel(e)} budget, with ${daysLeft} days left this month.` });
      else if (projectedTotal > e.budget * 1.1 && dom >= 5) {
        const over = projectedTotal - e.budget;
        alerts.push({ level: 'warn', ico: '📈', text: isAr
          ? `معدل صرفك الحالي في ${envLabel(e)} ممكن يخليك تتجاوز الميزانية بحوالي ${fmt(over)} ${state.settings.currency} آخر الشهر.`
          : `Your current pace in ${envLabel(e)} may push you about ${fmt(over)} ${state.settings.currency} over budget by month end.` });
      }
    }
  });
  const booksEnv = getEnvelope('env_books');
  if (booksEnv && booksEnv.balance > 0) alerts.push({ level: 'info', ico: '📚', text: `${money(booksEnv.balance)} ${isAr?'مخصصة للكتب':'set aside for books'}` });
  state.lessons.filter(l => l.status !== 'paid' && new Date(l.date) >= new Date(todayStr())).forEach(l => {
    const days = Math.round((new Date(l.date) - new Date(todayStr())) / 86400000);
    const dayText = isAr ? (days <= 0 ? 'النهاردة' : days === 1 ? 'باكر' : `خلال ${days} يوم`) : (days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`);
    alerts.push({ level: days <= 2 ? 'danger' : 'warn', ico: '📝', text: isAr ? `درس ${l.subject} — ${dayText}، ولسه مدفوعش` : `${l.subject} lesson — ${dayText}, not fully paid` });
  });
  state.savingsGoals.forEach(g => {
    if (g.target > 0 && g.current < g.target) {
      const pct = g.current / g.target;
      if (pct >= 0.8) alerts.push({ level: 'info', ico: '💾', text: `${g.name}: ${Math.round(pct*100)}% ${isAr?'من الهدف — قربت!':'of goal — almost there!'}` });
      else if (pct >= 0.5) alerts.push({ level: 'info', ico: '💾', text: `${g.name}: ${Math.round(pct*100)}% ${isAr?'من الهدف':'of goal'}` });
    }
  });
  const me = monthExpense(0), meLast = monthExpense(1);
  if (meLast > 0 && me > meLast) alerts.push({ level: 'warn', ico: '📉', text: isAr?'صرفك الشهر ده أعلى من الشهر اللي فات':'Spending this month is higher than last month' });
  const todayHasTx = state.transactions.some(tr => tr.date === todayStr());
  if (!todayHasTx && new Date().getHours() >= 19) alerts.push({ level: 'info', ico: '🔔', text: isAr?'لسه مسجلتش أي مصروف النهاردة':"You haven't logged any spending today" });
  return alerts;
}
function renderAlertsScreen() {
  const alerts = computeAlerts();
  return alerts.length === 0 ? emptyState('🎉', t('noAlerts'), '') : alerts.map(alertCardHtml).join('');
}

/* ============================== ENVELOPES ============================== */
function renderEnvelopesScreen() {
  recalcEnvelopeBalances();
  return `
    <div class="fab-row"><button class="btn btn-primary" onclick="openAddEnvelopeSheet()">➕ ${t('addEnvelope')}</button></div>
    <div class="env-grid">${state.envelopes.map(envCardHtml).join('')}</div>
    <div class="fab-row" style="margin-top:16px;">
      <button class="btn btn-outline" onclick="openTransferSheet()">🔄 ${t('transfer')}</button>
    </div>
  `;
}
function openEnvelopeDetail(id) { window.__envId = id; nav('envelopeDetail'); }
function renderEnvelopeDetail(id) {
  recalcEnvelopeBalances();
  const e = getEnvelope(id);
  if (!e) return emptyState('🪣', t('noEnvelopes'), '');
  const spent = envelopeSpent(id);
  const pct = e.budget > 0 ? Math.min(100, Math.round((spent / e.budget) * 100)) : 0;
  const txs = [...state.transactions].filter(tr =>
    (tr.type === 'expense' && tr.envelopeId === id) ||
    (tr.type === 'income' && tr.allocations && tr.allocations.some(a => a.envelopeId === id)) ||
    (tr.type === 'envelopeTransfer' && (tr.fromEnvelopeId === id || tr.toEnvelopeId === id))
  ).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  return `
    <div class="hero" style="background:linear-gradient(155deg, var(--primary) 0%, var(--primary-2) 100%);">
      <div class="label">${e.icon} ${envLabel(e)}</div>
      <div class="amount">${money(e.balance)}</div>
      ${e.budget > 0 ? `<div class="hero-row"><div class="hero-chip"><div class="l">${t('used')}</div><div class="v">${fmt(spent)}</div></div>
      <div class="hero-chip"><div class="l">${t('budget')}</div><div class="v">${fmt(e.budget)}</div></div></div>` : ''}
    </div>
    ${e.budget > 0 ? `<div class="progress-track" style="margin-bottom:14px;"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
    <div class="btn-row">
      <button class="btn btn-outline btn-sm" onclick="openEditBudgetSheet('${id}')">✏️ ${t('editBudget')}</button>
      <button class="btn btn-outline btn-sm" onclick="openTransferSheet('${id}')">🔄 ${t('transfer')}</button>
      ${e.custom ? `<button class="btn btn-danger btn-sm" onclick="deleteEnvelope('${id}')">🗑️</button>` : ''}
    </div>
    <div class="section-head"><h2>${t('recentActivity')}</h2></div>
    ${txs.length === 0 ? emptyState('📭', t('noTransactions'), '') : `<div class="card">${txs.map(txRowHtml).join('')}</div>`}
  `;
}
function deleteEnvelope(id) {
  state.envelopes = state.envelopes.filter(e => e.id !== id);
  saveState(); toast(t('deletedSuccess')); nav('envelopes');
}

function openAddEnvelopeSheet() {
  const icons = ['🎁','💻','🎒','🐾','✈️','🏠','🎨','⚽','🎵','📱','🚗','🏥'];
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addEnvelope')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('envelopeName')}</label><input type="text" id="newEnvName" placeholder="${t('envelopeName')}"></div>
    <div class="form-group"><label>${t('envelopeIcon')}</label>
      <div class="chip-select" id="iconPicker">${icons.map((i,idx)=>`<div class="chip ${idx===0?'selected':''}" data-ic="${i}" onclick="pickIcon(this)">${i}</div>`).join('')}</div>
    </div>
    <div class="form-group"><label>${t('budget')} (${state.settings.currency})</label><input type="number" id="newEnvBudget" placeholder="0"></div>
    <button class="btn btn-primary" onclick="saveNewEnvelope()">${t('save')}</button>
  `);
}
function pickIcon(el) { document.querySelectorAll('#iconPicker .chip').forEach(c => c.classList.remove('selected')); el.classList.add('selected'); }
function saveNewEnvelope() {
  const name = document.getElementById('newEnvName').value.trim();
  const icon = document.querySelector('#iconPicker .chip.selected')?.dataset.ic || '🎁';
  const budget = parseFloat(document.getElementById('newEnvBudget').value) || 0;
  if (!name) { toast(state.settings.language==='ar'?'اكتب اسم القسم':'Enter a name'); return; }
  state.envelopes.push({ id: uid(), key: 'custom', name, icon, budget, balance: 0, custom: true });
  saveState(); closeSheet(); toast(t('savedSuccess')); nav('envelopes');
}
function openEditBudgetSheet(id) {
  const e = getEnvelope(id);
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('editBudget')} — ${envLabel(e)}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('budget')} (${state.settings.currency})</label><input type="number" id="editBudgetInput" value="${e.budget}"></div>
    <button class="btn btn-primary" onclick="saveEditBudget('${id}')">${t('save')}</button>
  `);
}
function saveEditBudget(id) {
  const e = getEnvelope(id); e.budget = parseFloat(document.getElementById('editBudgetInput').value) || 0;
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}

/* ============================== ADD MONEY ============================== */
function captureAddMoneyDraft() {
  const rows = [...document.querySelectorAll('#splitRows .split-row')].map(r => ({
    envelopeId: r.querySelector('select').value,
    amount: r.querySelector('input').value,
  }));
  return {
    amount: document.getElementById('amAmount')?.value || '',
    selectedSource: document.querySelector('#sheet .chip.selected')?.dataset.src || null,
    date: document.getElementById('amDate')?.value || todayStr(),
    walletId: document.getElementById('amWallet')?.value || '',
    note: document.getElementById('amNote')?.value || '',
    rows,
  };
}
function openAddMoneySheet(prefillSourceId) {
  const draft = window.__incomeDraft; window.__incomeDraft = null;
  const selectedSrc = prefillSourceId || draft?.selectedSource || BUILTIN_INCOME_SOURCES[0];
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addMoney')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('amount')}</label><input type="number" id="amAmount" placeholder="0" value="${draft?.amount || ''}" oninput="updateSplitTotal()"></div>
    <div class="form-group"><label>${t('source')}</label>
      <div class="chip-select">
        ${allIncomeSources().map(s=>`<div class="chip ${s===selectedSrc?'selected':''}" data-src="${s}" onclick="selectChip(this,'amSrc')">${sourceIcon(s)} ${sourceLabel(s)}</div>`).join('')}
        <div class="chip" onclick="openAddIncomeSourceSheet()">➕ ${t('addIncomeSource')}</div>
      </div>
    </div>
    <div class="form-group"><label>${t('date')}</label><input type="date" id="amDate" value="${draft?.date || todayStr()}"></div>
    <div class="form-group"><label>${t('wallet')}</label>
      <select id="amWallet">${state.wallets.map(w=>`<option value="${w.id}" ${draft?.walletId===w.id?'selected':''}>${w.icon} ${walLabel(w)}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>${t('allocationTitle')}</label>
      <div id="splitRows"></div>
      <button class="btn btn-outline btn-sm" onclick="addSplitRow()">➕ ${state.settings.language==='ar'?'إضافة قسم':'Add envelope'}</button>
      <div class="split-total ok" id="splitTotalBox" style="margin-top:10px;">${t('ok')}</div>
    </div>
    <div class="form-group"><label>${t('note')}</label><textarea id="amNote">${draft?.note || ''}</textarea></div>
    <button class="btn btn-primary" onclick="saveAddMoney()">${t('save')}</button>
  `);
  if (draft && draft.rows && draft.rows.length) {
    draft.rows.forEach(r => {
      addSplitRow();
      const rows = document.querySelectorAll('#splitRows .split-row');
      const last = rows[rows.length - 1];
      last.querySelector('select').value = r.envelopeId;
      last.querySelector('input').value = r.amount;
    });
    updateSplitTotal();
  } else {
    addSplitRow();
  }
}
/** Small sub-sheet to add a new (custom) income source without losing what's already typed in Add Money. */
function openAddIncomeSourceSheet() {
  window.__incomeDraft = captureAddMoneyDraft();
  const icons = ['💵','🎁','💼','📚','📝','🏆','💳','🧧','🤝','📦','💰','🎓','🏷️','📈','↩️','⭐'];
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addIncomeSource')}</h3><button class="icon-btn" onclick="openAddMoneySheet()">✕</button></div>
    <div class="form-group"><label>${t('incomeSourceName')}</label><input type="text" id="newSrcName" placeholder="${t('incomeSourceName')}"></div>
    <div class="form-group"><label>${t('chooseIcon')}</label>
      <div class="chip-select" id="iconPicker">${icons.map((i,idx)=>`<div class="chip ${idx===0?'selected':''}" data-ic="${i}" onclick="pickIcon(this)">${i}</div>`).join('')}</div>
    </div>
    <button class="btn btn-primary" onclick="saveNewIncomeSource()">${t('save')}</button>
  `);
}
function saveNewIncomeSource() {
  const name = document.getElementById('newSrcName').value.trim();
  if (!name) { toast(t('enterSourceName')); return; }
  const icon = document.querySelector('#iconPicker .chip.selected')?.dataset.ic || '💰';
  const id = 'src_' + uid();
  state.incomeSources = state.incomeSources || [];
  state.incomeSources.push({ id, name, icon, custom: true });
  saveState();
  toast(t('savedSuccess'));
  openAddMoneySheet(id);
}
function selectChip(el, group) {
  el.parentElement.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
}
function addSplitRow() {
  const wrap = document.getElementById('splitRows');
  const row = document.createElement('div'); row.className = 'split-row';
  row.innerHTML = `
    <select onchange="updateSplitTotal()">${state.envelopes.map(e=>`<option value="${e.id}">${e.icon} ${envLabel(e)}</option>`).join('')}</select>
    <input type="number" placeholder="0" oninput="updateSplitTotal()">
    <button class="split-remove" onclick="this.parentElement.remove(); updateSplitTotal();">✕</button>`;
  wrap.appendChild(row);
  updateSplitTotal();
}
function updateSplitTotal() {
  const total = parseFloat(document.getElementById('amAmount')?.value) || 0;
  const rows = document.querySelectorAll('#splitRows .split-row input');
  let sum = 0; rows.forEach(r => sum += parseFloat(r.value) || 0);
  const box = document.getElementById('splitTotalBox');
  if (!box) return;
  const diff = Math.round((total - sum) * 100) / 100;
  if (diff === 0 && total > 0) { box.className = 'split-total ok'; box.textContent = `${t('splitTotal')}: ${fmt(sum)} — ${t('ok')}`; }
  else { box.className = 'split-total bad'; box.textContent = `${t('splitTotal')}: ${fmt(sum)} / ${fmt(total)} — ${t('mustEqualAmount')}`; }
}
function saveAddMoney() {
  const amount = parseFloat(document.getElementById('amAmount').value);
  if (!amount || amount <= 0) { toast(state.settings.language==='ar'?'اكتب مبلغ صحيح':'Enter a valid amount'); return; }
  const source = document.querySelector('#sheet .chip.selected')?.dataset.src || 'other';
  const date = document.getElementById('amDate').value || todayStr();
  const walletId = document.getElementById('amWallet').value;
  const note = document.getElementById('amNote').value;
  const rows = document.querySelectorAll('#splitRows .split-row');
  let allocations = []; let sum = 0;
  rows.forEach(r => {
    const envId = r.querySelector('select').value;
    const amt = parseFloat(r.querySelector('input').value) || 0;
    if (amt > 0) { allocations.push({ envelopeId: envId, amount: amt }); sum += amt; }
  });
  if (Math.round((sum - amount) * 100) !== 0) { toast(t('mustEqualAmount')); return; }
  state.transactions.push({ id: uid(), type: 'income', amount, source, date, walletId, note, allocations, createdAt: Date.now() });
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}

/* ============================== ADD EXPENSE ============================== */
function openAddExpenseSheet(prefillEnv, prefill) {
  prefill = prefill || {};
  window.__pendingReceiptFile = null;
  window.__cashPaid = Object.assign({}, prefill.paid || {});
  window.__cashChange = {};
  window.__cashChangeManual = false; window.__cashSkip = false;
  const cashWal = state.wallets.find(w => w.key === 'cash' || w.id === 'wal_cash');
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addExpense')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('amount')}</label><input type="number" inputmode="decimal" id="exAmount" placeholder="0" value="${prefill.amount ? escAttr(prefill.amount) : ''}" oninput="cashSectionRefresh()"></div>
    <div class="form-group"><label>${t('category')}</label>
      <div class="chip-select">${state.envelopes.map((e,i)=>`<div class="chip ${e.id===prefillEnv||(!prefillEnv&&i===0)?'selected':''}" data-env="${e.id}" onclick="selectChip(this)">${e.icon} ${envLabel(e)}</div>`).join('')}</div>
    </div>
    <div class="form-group"><label>${t('description')}</label><input type="text" id="exDesc" placeholder="${t('description')}"></div>
    <div class="form-group"><label>${t('date')}</label><input type="date" id="exDate" value="${todayStr()}"></div>
    <div class="form-group"><label>${t('wallet')}</label>
      <select id="exWallet" onchange="cashWalletChanged()">${state.wallets.map(w=>`<option value="${w.id}" ${cashWal && prefill.paid && w.id===cashWal.id ? 'selected' : ''}>${w.icon} ${walLabel(w)}</option>`).join('')}</select>
    </div>
    <div id="cashSection"></div>
    <div class="form-group"><label>${t('receipt')}</label>
      <input type="file" accept="image/*" id="exReceipt" onchange="previewReceipt(this)">
      <img id="exReceiptPreview" class="receipt-preview" style="display:none;">
    </div>
    <button class="btn btn-primary" onclick="saveAddExpense()">${t('save')}</button>
  `);
  cashWalletChanged();
}
function previewReceipt(input) {
  const file = input.files[0]; if (!file) return;
  window.__pendingReceiptFile = file;
  const reader = new FileReader();
  reader.onload = e => { const img = document.getElementById('exReceiptPreview'); img.src = e.target.result; img.style.display = 'block'; img.dataset.b64 = e.target.result; };
  reader.readAsDataURL(file);
}
async function saveAddExpense() {
  const amount = parseFloat(document.getElementById('exAmount').value);
  if (!amount || amount <= 0) { toast(state.settings.language==='ar'?'اكتب مبلغ صحيح':'Enter a valid amount'); return; }
  const envelopeId = document.querySelector('#sheet .chip.selected')?.dataset.env;
  const description = document.getElementById('exDesc').value;
  const date = document.getElementById('exDate').value || todayStr();
  const walletId = document.getElementById('exWallet').value;
  const e = getEnvelope(envelopeId);
  let cashInfo = null;
  if (isCashWalletId(walletId)) {
    if (!cashGate(amount, saveAddExpense)) return; // asks "how did you pay?" when nothing was picked
    const v = cashValidateAndBuild(amount);
    if (v.error) { toast(v.error); return; }
    cashInfo = v;
  }
  if (e && e.budget > 0) {
    const spentAfter = envelopeSpent(envelopeId) + amount;
    if (spentAfter > e.budget * 1.5) { if (!confirm(state.settings.language==='ar' ? 'المبلغ ده هيخلي القسم يتخطى الميزانية بكتير. تكمل؟' : "This will push the envelope well over budget. Continue?")) return; }
  }
  const saveBtn = document.querySelector('#sheet .btn-primary');
  const transactionId = uid();
  let receiptPath = null, receiptPendingLocal = false;
  const pendingFile = window.__pendingReceiptFile;
  if (pendingFile) {
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = state.settings.language==='ar' ? '...جاري رفع الإيصال' : 'Uploading receipt...'; }
    try {
      const uploaded = await window.SB.uploadReceipt(window.__uid, transactionId, pendingFile);
      receiptPath = uploaded.path;
    } catch (err) {
      // Offline or Supabase unreachable — keep the file locally (IndexedDB,
      // never base64 in localStorage/Firestore) and retry automatically once
      // we're back online.
      try { await savePendingReceipt(transactionId, pendingFile); receiptPendingLocal = true; } catch (e2) { /* IndexedDB unavailable — receipt is lost, nothing more we can do */ }
      toast(state.settings.language==='ar' ? 'تعذّر رفع الإيصال أونلاين — هيترفع تلقائيًا أول ما يرجع النت' : "Couldn't upload the receipt online — it'll upload automatically once you're back online");
    }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = t('save'); }
  }
  window.__pendingReceiptFile = null;
  const cashFields = (cashInfo && cashInfo.paid) ? { cashPaid: cashInfo.paid, cashChange: cashInfo.change } : {};
  if (cashFields.cashPaid) applyCashMovement(cashFields.cashPaid, cashFields.cashChange, +1);
  state.transactions.push(Object.assign({ id: transactionId, type: 'expense', amount, envelopeId, description, date, walletId, receiptPath, receiptPendingLocal, createdAt: Date.now() }, cashFields));
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}

/* ============================== TRANSFER ============================== */
function openTransferSheet(fromId) {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('transfer')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('fromEnvelope')}</label>
      <select id="trFrom">${state.envelopes.map(e=>`<option value="${e.id}" ${e.id===fromId?'selected':''}>${e.icon} ${envLabel(e)} (${money(e.balance)})</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>${t('toEnvelope')}</label>
      <select id="trTo">${state.envelopes.map(e=>`<option value="${e.id}">${e.icon} ${envLabel(e)}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>${t('transferAmount')}</label><input type="number" id="trAmount" placeholder="0"></div>
    <button class="btn btn-primary" onclick="saveTransfer()">${t('doTransfer')}</button>
    <div class="divider"></div>
    <div class="section-head" style="margin-top:0;"><h2>${t('transferWallet')}</h2></div>
    <div class="form-group"><label>${t('fromWallet')}</label>
      <select id="trWalFrom">${state.wallets.map(w=>`<option value="${w.id}">${w.icon} ${walLabel(w)} (${money(walletBalance(w.id))})</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>${t('toWallet')}</label>
      <select id="trWalTo">${state.wallets.map(w=>`<option value="${w.id}">${w.icon} ${walLabel(w)}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>${t('transferAmount')}</label><input type="number" id="trWalAmount" placeholder="0"></div>
    <button class="btn btn-outline" onclick="saveWalletTransfer()">${t('doTransfer')}</button>
  `);
}
function saveTransfer() {
  const from = document.getElementById('trFrom').value, to = document.getElementById('trTo').value;
  const amount = parseFloat(document.getElementById('trAmount').value);
  if (!amount || amount <= 0) { toast(state.settings.language==='ar'?'اكتب مبلغ صحيح':'Enter a valid amount'); return; }
  if (from === to) { toast(state.settings.language==='ar'?'اختار قسمين مختلفين':'Choose two different envelopes'); return; }
  recalcEnvelopeBalances();
  const fromEnv = getEnvelope(from);
  if (fromEnv.balance < amount) { toast(t('notEnoughBalance')); return; }
  state.transactions.push({ id: uid(), type: 'envelopeTransfer', amount, fromEnvelopeId: from, toEnvelopeId: to, date: todayStr(), createdAt: Date.now() });
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}
function saveWalletTransfer() {
  const from = document.getElementById('trWalFrom').value, to = document.getElementById('trWalTo').value;
  const amount = parseFloat(document.getElementById('trWalAmount').value);
  if (!amount || amount <= 0) { toast(state.settings.language==='ar'?'اكتب مبلغ صحيح':'Enter a valid amount'); return; }
  if (from === to) { toast(state.settings.language==='ar'?'اختار محفظتين مختلفتين':'Choose two different wallets'); return; }
  state.transactions.push({ id: uid(), type: 'walletTransfer', amount, fromWalletId: from, toWalletId: to, date: todayStr(), createdAt: Date.now() });
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}

/* ============================== BOOKS ============================== */
function renderBooks() {
  const books = [...state.books].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const totalReceived = books.reduce((a,b)=>a+(b.received||0),0);
  const totalPaid = books.reduce((a,b)=>a+(b.paid||0),0);
  return `
    <div class="month-row">
      <div class="month-card"><div class="v">${fmt(totalReceived)}</div><div class="l">${t('receivedShort')}</div></div>
      <div class="month-card"><div class="v">${fmt(totalPaid)}</div><div class="l">${t('paidLbl')}</div></div>
    </div>
    <div class="fab-row"><button class="btn btn-primary" onclick="openAddBookSheet()">➕ ${t('addBook')}</button></div>
    ${books.length===0 ? emptyState('📚', t('noBooks'), t('addFirst')) : books.map(bookCardHtml).join('')}
  `;
}
function bookCardHtml(b) {
  const statusMap = { pending: 'pending', partial: 'partial', paid: 'paid' };
  const statusLbl = { pending: t('pending'), partial: t('partiallyPaid'), paid: t('paid') };
  return `
  <div class="card">
    <div class="list-row" style="border:none; padding-top:0;">
      <div class="ico-badge">📚</div>
      <div class="mid"><div class="t1">${b.name}</div><div class="t2">${t('priceShort')}: ${money(b.expectedPrice)}</div></div>
      <span class="badge ${statusMap[b.status]}">${statusLbl[b.status]}</span>
    </div>
    <div class="small-note">${t('receivedShort')}: ${fmt(b.received)} · ${t('paidLbl')}: ${fmt(b.paid)}</div>
    <div class="btn-row" style="margin-top:10px;">
      ${b.status!=='paid' ? `<button class="btn btn-outline btn-sm" onclick="openMarkBookPaid('${b.id}')">✅ ${t('markPaid')}</button>` : ''}
      <button class="btn btn-danger btn-sm" onclick="deleteBook('${b.id}')">🗑️</button>
    </div>
  </div>`;
}
function openAddBookSheet() {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addBook')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('bookName')}</label><input type="text" id="bkName"></div>
    <div class="form-group"><label>${t('expectedPrice')}</label><input type="number" id="bkPrice"></div>
    <div class="form-group"><label>${t('amountReceived')}</label><input type="number" id="bkReceived" value="0"></div>
    <div class="form-group"><label>${t('date')}</label><input type="date" id="bkDate" value="${todayStr()}"></div>
    <div class="form-group"><label>${t('note')}</label><textarea id="bkNote"></textarea></div>
    <button class="btn btn-primary" onclick="saveBook()">${t('save')}</button>
  `);
}
function saveBook() {
  const name = document.getElementById('bkName').value.trim();
  const expectedPrice = parseFloat(document.getElementById('bkPrice').value) || 0;
  const received = parseFloat(document.getElementById('bkReceived').value) || 0;
  const date = document.getElementById('bkDate').value || todayStr();
  const note = document.getElementById('bkNote').value;
  if (!name) { toast(state.settings.language==='ar'?'اكتب اسم الكتاب':'Enter book name'); return; }
  state.books.push({ id: uid(), name, expectedPrice, received, paid: 0, date, status: 'pending', note, createdAt: Date.now() });
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}
function openMarkBookPaid(id) {
  const b = state.books.find(x=>x.id===id);
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${b.name}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('amountPaid')}</label><input type="number" id="bkPaid" value="${b.expectedPrice}"></div>
    <p class="small-note">${state.settings.language==='ar'?'المستلم':'Received'}: ${money(b.received)}</p>
    <button class="btn btn-primary" onclick="confirmBookPaid('${id}')">${t('save')}</button>
  `);
}
function confirmBookPaid(id) {
  const b = state.books.find(x=>x.id===id);
  const paid = parseFloat(document.getElementById('bkPaid').value) || 0;
  b.paid = paid; b.status = paid >= b.expectedPrice ? 'paid' : (paid > 0 ? 'partial' : 'pending');
  state.transactions.push({ id: uid(), type: 'expense', amount: paid, envelopeId: 'env_books', description: b.name, date: todayStr(), walletId: state.wallets[0]?.id, createdAt: Date.now() });
  const diff = Math.round((b.received - paid) * 100) / 100;
  closeSheet();
  if (diff > 0) {
    openSheet(`
      <div class="sheet-handle"></div>
      <div class="sheet-head"><h3>${t('whatHappenedDiff')}</h3></div>
      <p class="small-note">${money(diff)}</p>
      <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
        <button class="btn btn-outline" onclick="resolveBookDiff('${id}', ${diff}, 'returned')">↩️ ${t('returned')}</button>
        <button class="btn btn-outline" onclick="resolveBookDiff('${id}', ${diff}, 'personal')">👤 ${t('addedPersonal')}</button>
        <button class="btn btn-outline" onclick="resolveBookDiff('${id}', ${diff}, 'keep')">📚 ${t('keepBooks')}</button>
      </div>
    `);
  } else { saveState(); toast(t('savedSuccess')); render(); }
}
function resolveBookDiff(id, diff, choice) {
  if (choice === 'personal') {
    state.transactions.push({ id: uid(), type: 'envelopeTransfer', amount: diff, fromEnvelopeId: 'env_books', toEnvelopeId: 'env_personal', date: todayStr(), createdAt: Date.now() });
  } else if (choice === 'returned') {
    state.transactions.push({ id: uid(), type: 'expense', amount: diff, envelopeId: 'env_books', description: t('returned'), date: todayStr(), walletId: state.wallets[0]?.id, createdAt: Date.now() });
  }
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}
function deleteBook(id) { state.books = state.books.filter(b=>b.id!==id); saveState(); toast(t('deletedSuccess')); render(); }

/* ============================== LESSONS ============================== */
function renderLessons() {
  const lessons = [...state.lessons].sort((a,b)=>new Date(a.date)-new Date(b.date));
  const total = lessons.reduce((a,b)=>a+b.price,0);
  const paidTotal = lessons.filter(l=>l.status==='paid').reduce((a,b)=>a+b.price,0);
  return `
    <div class="month-row">
      <div class="month-card"><div class="v">${fmt(total)}</div><div class="l">${t('totalLessonsMoney')}</div></div>
      <div class="month-card"><div class="v">${fmt(paidTotal)}</div><div class="l">${t('paidLbl')}</div></div>
      <div class="month-card"><div class="v">${fmt(total-paidTotal)}</div><div class="l">${t('remainingLbl')}</div></div>
    </div>
    <div class="fab-row"><button class="btn btn-primary" onclick="openAddLessonSheet()">➕ ${t('addLesson')}</button></div>
    ${lessons.length===0 ? emptyState('📝', t('noLessons'), t('addFirst')) : lessons.map(lessonCardHtml).join('')}
  `;
}
function lessonCardHtml(l) {
  const statusLbl = { unpaid: t('unpaid'), partial: t('partiallyPaid'), paid: t('paid') };
  const statusClass = { unpaid: 'pending', partial: 'partial', paid: 'paid' };
  return `
  <div class="card">
    <div class="list-row" style="border:none; padding-top:0;">
      <div class="ico-badge">📝</div>
      <div class="mid"><div class="t1">${l.subject}</div><div class="t2">${l.teacher} · ${l.date}</div></div>
      <span class="badge ${statusClass[l.status]}">${statusLbl[l.status]}</span>
    </div>
    <div class="small-note">${t('lessonPrice')}: ${money(l.price)}</div>
    <div class="btn-row" style="margin-top:10px;">
      ${l.status!=='paid' ? `<button class="btn btn-outline btn-sm" onclick="markLessonPaid('${l.id}')">✅ ${t('markPaid')}</button>` : ''}
      <button class="btn btn-danger btn-sm" onclick="deleteLesson('${l.id}')">🗑️</button>
    </div>
  </div>`;
}
function openAddLessonSheet() {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addLesson')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('subject')}</label><input type="text" id="lsSubject"></div>
    <div class="form-group"><label>${t('teacher')}</label><input type="text" id="lsTeacher"></div>
    <div class="form-group"><label>${t('lessonPrice')}</label><input type="number" id="lsPrice"></div>
    <div class="form-group"><label>${t('date')}</label><input type="date" id="lsDate" value="${todayStr()}"></div>
    <div class="form-group"><label>${t('note')}</label><textarea id="lsNote"></textarea></div>
    <button class="btn btn-primary" onclick="saveLesson()">${t('save')}</button>
  `);
}
function saveLesson() {
  const subject = document.getElementById('lsSubject').value.trim();
  const teacher = document.getElementById('lsTeacher').value.trim();
  const price = parseFloat(document.getElementById('lsPrice').value) || 0;
  const date = document.getElementById('lsDate').value || todayStr();
  const notes = document.getElementById('lsNote').value;
  if (!subject) { toast(state.settings.language==='ar'?'اكتب اسم المادة':'Enter subject'); return; }
  state.lessons.push({ id: uid(), subject, teacher, price, date, status: 'unpaid', notes, createdAt: Date.now() });
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}
function markLessonPaid(id) {
  const l = state.lessons.find(x=>x.id===id); l.status = 'paid';
  state.transactions.push({ id: uid(), type: 'expense', amount: l.price, envelopeId: 'env_lessons', description: l.subject, date: todayStr(), walletId: state.wallets[0]?.id, createdAt: Date.now() });
  saveState(); toast(t('savedSuccess')); render();
}
function deleteLesson(id) { state.lessons = state.lessons.filter(l=>l.id!==id); saveState(); toast(t('deletedSuccess')); render(); }

/* ============================== WALLETS ============================== */
function renderWallets() {
  return `
    <div class="hero">
      <div class="label">${t('totalAcrossWallets')}</div>
      <div class="amount">${money(totalAcrossWallets())}</div>
    </div>
    <div class="fab-row"><button class="btn btn-primary" onclick="openAddWalletSheet()">➕ ${t('addWallet')}</button></div>
    ${state.wallets.map(w => `
    <div class="card">
      <div class="list-row" style="border:none; padding-top:0;">
        <div class="ico-badge">${w.icon}</div>
        <div class="mid"><div class="t1">${walLabel(w)}</div></div>
        <div class="amt neu">${money(walletBalance(w.id))}</div>
      </div>
      ${w.custom ? `<button class="btn btn-danger btn-sm" onclick="deleteWallet('${w.id}')">🗑️</button>` : ''}
    </div>`).join('')}
  `;
}
function openAddWalletSheet() {
  const icons = ['👛','📱','🏦','💳','🪙','🐷'];
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addWallet')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('walletName')}</label><input type="text" id="wlName"></div>
    <div class="form-group"><label>${t('chooseIcon')}</label>
      <div class="chip-select" id="wlIconPicker">${icons.map((i,idx)=>`<div class="chip ${idx===0?'selected':''}" data-ic="${i}" onclick="pickIcon2(this)">${i}</div>`).join('')}</div>
    </div>
    <button class="btn btn-primary" onclick="saveWallet()">${t('save')}</button>
  `);
}
function pickIcon2(el){ document.querySelectorAll('#wlIconPicker .chip').forEach(c=>c.classList.remove('selected')); el.classList.add('selected'); }
function saveWallet() {
  const name = document.getElementById('wlName').value.trim();
  const icon = document.querySelector('#wlIconPicker .chip.selected')?.dataset.ic || '👛';
  if (!name) { toast(state.settings.language==='ar'?'اكتب اسم المحفظة':'Enter wallet name'); return; }
  state.wallets.push({ id: uid(), key: 'custom', name, icon, custom: true });
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}
function deleteWallet(id) { state.wallets = state.wallets.filter(w=>w.id!==id); saveState(); toast(t('deletedSuccess')); render(); }

/* ============================== SAVINGS GOALS ============================== */
function renderGoals() {
  const goals = state.savingsGoals;
  return `
    <div class="fab-row"><button class="btn btn-primary" onclick="openAddGoalSheet()">➕ ${t('addGoal')}</button></div>
    ${goals.length===0 ? emptyState('🎯', t('noGoals'), t('addFirst')) : goals.map(goalCardHtml).join('')}
  `;
}
function goalCardHtml(g) {
  const pct = g.target > 0 ? Math.min(100, Math.round((g.current/g.target)*100)) : 0;
  return `
  <div class="card goal-card">
    <div class="top"><div class="name">🎯 ${g.name}</div><div class="pct">${pct}%</div></div>
    <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div class="small-note" style="margin-top:8px;">${fmt(g.current)} ${t('of')} ${fmt(g.target)} ${state.settings.currency}${g.deadline? ' · '+g.deadline:''}</div>
    <div class="btn-row" style="margin-top:10px;">
      <button class="btn btn-outline btn-sm" onclick="openAddToGoalSheet('${g.id}')">💾 ${t('addToGoal')}</button>
      <button class="btn btn-danger btn-sm" onclick="deleteGoal('${g.id}')">🗑️</button>
    </div>
  </div>`;
}
function openAddGoalSheet() {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addGoal')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('goalName')}</label><input type="text" id="glName"></div>
    <div class="form-group"><label>${t('target')}</label><input type="number" id="glTarget"></div>
    <div class="form-group"><label>${t('current')}</label><input type="number" id="glCurrent" value="0"></div>
    <div class="form-group"><label>${t('deadline')}</label><input type="date" id="glDeadline"></div>
    <div class="form-group"><label>${t('priority')}</label>
      <div class="chip-select">
        <div class="chip selected" data-p="low" onclick="selectChip(this)">${t('low')}</div>
        <div class="chip" data-p="medium" onclick="selectChip(this)">${t('medium')}</div>
        <div class="chip" data-p="high" onclick="selectChip(this)">${t('high')}</div>
      </div>
    </div>
    <button class="btn btn-primary" onclick="saveGoal()">${t('save')}</button>
  `);
}
function saveGoal() {
  const name = document.getElementById('glName').value.trim();
  const target = parseFloat(document.getElementById('glTarget').value) || 0;
  const current = parseFloat(document.getElementById('glCurrent').value) || 0;
  const deadline = document.getElementById('glDeadline').value;
  const priority = document.querySelector('#sheet .chip.selected')?.dataset.p || 'low';
  if (!name || target <= 0) { toast(state.settings.language==='ar'?'اكتب اسم وهدف صحيح':'Enter a name and valid target'); return; }
  state.savingsGoals.push({ id: uid(), name, target, current, deadline, priority, createdAt: Date.now() });
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}
function openAddToGoalSheet(id) {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addToGoal')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('amount')}</label><input type="number" id="glAddAmount"></div>
    <button class="btn btn-primary" onclick="saveAddToGoal('${id}')">${t('save')}</button>
  `);
}
function saveAddToGoal(id) {
  const amount = parseFloat(document.getElementById('glAddAmount').value);
  if (!amount || amount <= 0) { toast(state.settings.language==='ar'?'اكتب مبلغ صحيح':'Enter a valid amount'); return; }
  recalcEnvelopeBalances();
  const savingsEnv = getEnvelope('env_savings');
  if (savingsEnv.balance < amount) { toast(t('notEnoughBalance')); return; }
  const g = state.savingsGoals.find(x=>x.id===id); g.current += amount;
  state.transactions.push({ id: uid(), type: 'expense', amount, envelopeId: 'env_savings', description: `🎯 ${g.name}`, date: todayStr(), createdAt: Date.now() });
  state.transactions.push({ id: uid(), type: 'goalSave', amount, goalId: id, date: todayStr(), createdAt: Date.now() });
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}
function deleteGoal(id) { state.savingsGoals = state.savingsGoals.filter(g=>g.id!==id); saveState(); toast(t('deletedSuccess')); render(); }

/* ============================== PLANNED EXPENSES ============================== */
function renderPlanned() {
  const list = [...state.plannedExpenses].sort((a,b)=>new Date(a.date)-new Date(b.date));
  const total = list.reduce((a,b)=>a+b.amount,0);
  return `
    <div class="hero"><div class="label">${t('totalPlanned')}</div><div class="amount">${money(total)}</div></div>
    <div class="fab-row"><button class="btn btn-primary" onclick="openAddPlannedSheet()">➕ ${t('addPlanned')}</button></div>
    ${list.length===0 ? emptyState('📌', t('noPlanned'), t('addFirst')) : list.map(p => `
    <div class="card">
      <div class="list-row" style="border:none; padding-top:0;">
        <div class="ico-badge">📌</div>
        <div class="mid"><div class="t1">${p.name}</div><div class="t2">${p.date}${p.reserved?' · 🔒 '+t('reserveMoney'):''}</div></div>
        <div class="amt neu">${money(p.amount)}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deletePlanned('${p.id}')">🗑️</button>
    </div>`).join('')}
  `;
}
function openAddPlannedSheet() {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addPlanned')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('planName')}</label><input type="text" id="plName"></div>
    <div class="form-group"><label>${t('amount')}</label><input type="number" id="plAmount"></div>
    <div class="form-group"><label>${t('date')}</label><input type="date" id="plDate" value="${todayStr()}"></div>
    <div class="form-group"><label><input type="checkbox" id="plReserve" checked> ${t('reserveMoney')}</label></div>
    <button class="btn btn-primary" onclick="savePlanned()">${t('save')}</button>
  `);
}
function savePlanned() {
  const name = document.getElementById('plName').value.trim();
  const amount = parseFloat(document.getElementById('plAmount').value) || 0;
  const date = document.getElementById('plDate').value || todayStr();
  const reserved = document.getElementById('plReserve').checked;
  if (!name || amount <= 0) { toast(state.settings.language==='ar'?'اكتب بيانات صحيحة':'Enter valid details'); return; }
  state.plannedExpenses.push({ id: uid(), name, amount, date, reserved, createdAt: Date.now() });
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}
function deletePlanned(id) { state.plannedExpenses = state.plannedExpenses.filter(p=>p.id!==id); saveState(); toast(t('deletedSuccess')); render(); }

/* ============================== WHERE IS MY MONEY ============================== */
function renderWhereIsMoney() {
  recalcEnvelopeBalances();
  const tb = totalBalance();
  return `
    <div class="hero"><div class="label">💰 ${t('total')}</div><div class="amount">${money(tb)}</div></div>
    <div class="card">
      ${state.envelopes.map(e => `
        <div class="list-row">
          <div class="ico-badge">${e.icon}</div>
          <div class="mid"><div class="t1">${envLabel(e)}</div></div>
          <div class="amt neu">${money(e.balance)}</div>
        </div>`).join('')}
    </div>
    <p class="small-note">${state.settings.language==='ar' ? 'مجموع كل الأقسام لازم يساوي رصيدك الكلي بالظبط.' : 'The sum of all envelopes should exactly equal your total balance.'}</p>
  `;
}

/* ============================== CAN I BUY THIS ============================== */
function renderCanIBuy() {
  return `
    <div class="form-group"><label>${t('itemPrice')}</label><input type="number" id="cbAmount"></div>
    <button class="btn btn-primary" onclick="checkCanIBuy()">${t('checkNow')}</button>
    <div id="cbResult"></div>
  `;
}
function checkCanIBuy() {
  const price = parseFloat(document.getElementById('cbAmount').value);
  if (!price || price <= 0) { toast(state.settings.language==='ar'?'اكتب سعر صحيح':'Enter a valid price'); return; }
  const isAr = state.settings.language === 'ar';
  const av = availableMoney();
  const rv = reservedMoney();
  const proj = projectedEndOfMonthBalance();
  const upcomingPlanned = state.plannedExpenses.filter(p => new Date(p.date) >= new Date(todayStr())).reduce((a,b)=>a+b.amount,0);
  const activeGoalsTotal = state.savingsGoals.filter(g=>g.current<g.target).reduce((a,g)=>a+(g.target-g.current),0);
  const remaining = av - price;
  const remainingAfterCommitments = remaining - upcomingPlanned;
  const remainingProjected = proj.projected - price;

  let verdict, cls, ico;
  if (remaining < 0) { verdict = t('canBuyNo'); cls = 'danger'; ico = '🔴'; }
  else if (remainingAfterCommitments < 0 || remainingProjected < 0) { verdict = t('canBuyTight'); cls = 'warn'; ico = '🟡'; }
  else if (remaining < av * 0.15) { verdict = t('canBuyTight'); cls = 'warn'; ico = '🟡'; }
  else { verdict = t('canBuyYes'); cls = 'info'; ico = '🟢'; }

  const reasoning = [];
  reasoning.push(isAr ? `متاح عندك: ${fmt(av)} ${state.settings.currency}` : `Available: ${fmt(av)} ${state.settings.currency}`);
  if (rv > 0) reasoning.push(isAr ? `محجوز حاليًا: ${fmt(rv)} ${state.settings.currency} (أهداف توفير + مصاريف مخططة)` : `Currently reserved: ${fmt(rv)} ${state.settings.currency} (goals + planned expenses)`);
  if (upcomingPlanned > 0) reasoning.push(isAr ? `عندك مصاريف مخططة قادمة بقيمة ${fmt(upcomingPlanned)} ${state.settings.currency}` : `You have upcoming planned expenses of ${fmt(upcomingPlanned)} ${state.settings.currency}`);
  reasoning.push(isAr ? `لو استمريت بمعدل صرفك الحالي، متوقع يفضلّك ${fmt(proj.projected)} ${state.settings.currency} آخر الشهر` : `At your current spending pace, you're projected to have ${fmt(proj.projected)} ${state.settings.currency} left by month end`);

  document.getElementById('cbResult').innerHTML = `
    <div class="alert-card ${cls}" style="margin-top:16px;"><div style="font-size:20px">${ico}</div><div class="t">${verdict}</div></div>
    <div class="card">
      <div class="list-row"><div class="mid t1">${t('available')}</div><div class="amt neu">${money(av)}</div></div>
      <div class="list-row"><div class="mid t1">${t('remainingAfter')}</div><div class="amt ${remaining<0?'neg':'pos'}">${money(remaining)}</div></div>
      <div class="list-row"><div class="mid t1">${isAr?'بعد المصاريف المخططة':'After planned expenses'}</div><div class="amt ${remainingAfterCommitments<0?'neg':'pos'}">${money(remainingAfterCommitments)}</div></div>
      <div class="list-row"><div class="mid t1">${isAr?'المتوقع آخر الشهر لو اشتريتها':'Projected month-end if bought'}</div><div class="amt ${remainingProjected<0?'neg':'pos'}">${money(remainingProjected)}</div></div>
    </div>
    <div class="card"><p class="small-note" style="line-height:2;">${reasoning.map(r=>'• '+r).join('<br>')}</p></div>
    ${remaining>=0 ? `<button class="btn btn-primary" onclick="confirmCanIBuyPurchase(${price})">${t('confirmPurchase')}</button>` : ''}
  `;
}
function confirmCanIBuyPurchase(price) {
  state.transactions.push({ id: uid(), type: 'expense', amount: price, envelopeId: 'env_personal', description: t('canIBuy'), date: todayStr(), walletId: state.wallets[0]?.id, createdAt: Date.now() });
  saveState(); toast(t('savedSuccess')); nav('dashboard');
}

/* ============================== HISTORY ============================== */
window.__histFilter = 'all';
window.__histSearch = '';
function normAr(x) {
  return String(x == null ? '' : x).toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, ch => String(ch.charCodeAt(0) - 1632));
}
function escAttr(x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function histResultsHtml() {
  let txs = [...state.transactions];
  const now = new Date();
  if (window.__histFilter === 'today') txs = txs.filter(tr => tr.date === todayStr());
  else if (window.__histFilter === 'thisWeek') { const wk = new Date(now); wk.setDate(now.getDate()-7); txs = txs.filter(tr => new Date(tr.date) >= wk); }
  else if (window.__histFilter === 'thisMonthF') { const key = todayStr().slice(0, 7); txs = txs.filter(tr => String(tr.date || '').slice(0, 7) === key); }
  else if (window.__histFilter === 'incomeF') txs = txs.filter(tr => tr.type === 'income');
  else if (window.__histFilter === 'expenseF') txs = txs.filter(tr => tr.type === 'expense');
  else if (window.__histFilter === 'transferF') txs = txs.filter(tr => tr.type === 'envelopeTransfer' || tr.type === 'walletTransfer');
  const q = normAr((window.__histSearch || '').trim());
  if (q) {
    txs = txs.filter(tr => {
      const env = tr.envelopeId ? getEnvelope(tr.envelopeId) : null;
      const hay = normAr([txTitle(tr), tr.note, tr.description, tr.amount, tr.date, env ? envLabel(env) : ''].join(' '));
      return hay.includes(q);
    });
  }
  txs.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const groups = {};
  txs.forEach(tr => { (groups[tr.date] = groups[tr.date] || []).push(tr); });
  const dateKeys = Object.keys(groups).sort((a,b)=> new Date(b)-new Date(a));
  return dateKeys.length === 0 ? emptyState('📭', t('noTransactions'), t('noTransactionsSub')) :
    dateKeys.map(dk => `<div class="day-group-label">${dk}</div><div class="card">${groups[dk].map(tr=>txRowHtmlEditable(tr)).join('')}</div>`).join('');
}
// Update ONLY the results list while typing — re-rendering the whole screen
// destroyed the <input>, which is why the keyboard/focus was lost after every letter.
function onHistSearch(v) {
  window.__histSearch = v;
  const el = document.getElementById('histResults');
  if (el) el.innerHTML = histResultsHtml();
}
function renderHistory() {
  const filters = ['all','today','thisWeek','thisMonthF','incomeF','expenseF','transferF'];
  return `
    <div class="search-bar">
      <input type="text" id="histSearchInput" autocomplete="off" enterkeyhint="search" placeholder="${t('searchPlaceholder')}" value="${escAttr(window.__histSearch)}" oninput="onHistSearch(this.value)">
    </div>
    <div class="filter-chips">${filters.map(f=>`<div class="chip ${window.__histFilter===f?'selected':''}" onclick="window.__histFilter='${f}'; render();">${t(f)}</div>`).join('')}</div>
    <div id="histResults">${histResultsHtml()}</div>
  `;
}
function txRowHtmlEditable(tr) {
  const sign = tr.type === 'income' ? 'pos' : (tr.type === 'expense' || tr.type === 'goalSave') ? 'neg' : 'neu';
  const amt = (tr.type === 'income') ? `+${fmt(tr.amount)}` : (tr.type === 'expense' || tr.type === 'goalSave') ? `-${fmt(tr.amount)}` : fmt(tr.amount);
  return `
  <div class="list-row" onclick="openTxDetail('${tr.id}')" style="cursor:pointer;">
    <div class="ico-badge">${txIcon(tr)}</div>
    <div class="mid"><div class="t1">${txTitle(tr)}</div><div class="t2">${tr.date}</div></div>
    <div class="amt ${sign}">${amt} ${state.settings.currency}</div>
  </div>`;
}
function openTxDetail(id) {
  const tr = state.transactions.find(x=>x.id===id);
  if (!tr) return;
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${txTitle(tr)}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="card">
      <div class="list-row"><div class="mid t1">${t('amount')}</div><div class="amt neu">${money(tr.amount)}</div></div>
      <div class="list-row"><div class="mid t1">${t('date')}</div><div class="amt neu">${tr.date}</div></div>
      ${tr.note ? `<div class="list-row"><div class="mid t1">${t('note')}</div><div class="amt neu">${tr.note}</div></div>` : ''}
      ${tr.cashPaid ? `<div class="list-row"><div class="mid t1">💵 ${isArabic()?'دفعت':'Paid with'}</div><div class="amt neu" style="font-size:12px;">${denSummary(tr.cashPaid)}</div></div>` : ''}
      ${tr.cashChange && Object.keys(tr.cashChange).length ? `<div class="list-row"><div class="mid t1">↩️ ${t('change')}</div><div class="amt neu" style="font-size:12px;">${denSummary(tr.cashChange)}</div></div>` : ''}
      <div id="txReceiptArea">${receiptAreaPlaceholder(tr)}</div>
    </div>
    <button class="btn btn-danger" onclick="deleteTx('${id}')">🗑️ ${t('delete')}</button>
  `);
  refreshTxReceiptArea(id);
}
/** Initial (synchronous) content of the receipt area, before any signed-URL fetch. */
function receiptAreaPlaceholder(tr) {
  if (tr.receiptPendingLocal) return `<div class="receipt-pending-note">${t('receiptPendingNote')}</div>`;
  if (tr.receiptPath) return `<div class="receipt-pending-note">${t('loadingReceipt')}</div>`;
  if (tr.receipt) return `<img src="${tr.receipt}" class="receipt-preview">`; // legacy base64 from before this device had Supabase Storage
  return `<div class="form-group"><label>${t('receipt')}</label>
    <input type="file" accept="image/*" onchange="attachReceiptToTx('${tr.id}', this)">
  </div>`;
}
/** Fetches a fresh signed URL (if needed) and fills in #txReceiptArea. Safe to call even if the sheet has since closed. */
async function refreshTxReceiptArea(id) {
  const tr = state.transactions.find(x=>x.id===id);
  const area = document.getElementById('txReceiptArea');
  if (!tr || !area) return;
  if (!tr.receiptPath) return; // pending-local / legacy-base64 / no-receipt views are already final, nothing async to do
  const url = window.SB ? await window.SB.getSignedUrl(tr.receiptPath) : null;
  const freshTr = state.transactions.find(x=>x.id===id); // re-check in case it was deleted while we awaited
  const freshArea = document.getElementById('txReceiptArea');
  if (!freshTr || !freshArea) return;
  freshArea.innerHTML = url
    ? `<img src="${url}" class="receipt-preview"><div class="btn-row" style="margin-top:8px;"><button class="btn btn-outline btn-sm" onclick="removeReceiptFromTx('${id}')">🗑 ${t('removeReceipt')}</button></div>`
    : `<div class="receipt-pending-note">${state.settings.language==='ar' ? 'تعذّر تحميل الإيصال — تأكد إنك أونلاين' : "Couldn't load the receipt — check you're online"}</div>`;
}
/** Attach a receipt to an existing transaction that doesn't have one yet. */
async function attachReceiptToTx(id, input) {
  const file = input.files[0]; if (!file) return;
  const tr = state.transactions.find(x=>x.id===id);
  if (!tr) return;
  const area = document.getElementById('txReceiptArea');
  if (area) area.innerHTML = `<div class="receipt-pending-note">${state.settings.language==='ar' ? '...جاري رفع الإيصال' : 'Uploading receipt...'}</div>`;
  try {
    await uploadTransactionReceipt(tr, file);
    toast(t('savedSuccess'));
  } catch (err) {
    try { await savePendingReceipt(id, file); tr.receiptPendingLocal = true; saveState(); } catch (e2) { /* IndexedDB unavailable */ }
    toast(state.settings.language==='ar' ? 'تعذّر رفع الإيصال أونلاين — هيترفع تلقائيًا أول ما يرجع النت' : "Couldn't upload the receipt online — it'll upload automatically once you're back online");
  }
  openTxDetail(id); // re-render the sheet with the new state
}
/** Remove the receipt attached to a transaction (from Supabase Storage + the transaction record). */
async function removeReceiptFromTx(id) {
  if (!confirm(t('receiptDeleteConfirm'))) return;
  const tr = state.transactions.find(x=>x.id===id);
  if (!tr) return;
  if (tr.receiptPath && window.SB) { try { await window.SB.deleteReceipt(tr.receiptPath); } catch (e) { /* non-fatal */ } }
  tr.receiptPath = null; tr.receipt = null; tr.receiptPendingLocal = false;
  saveState(); toast(t('deletedSuccess'));
  openTxDetail(id);
}
function deleteTx(id) {
  const tr = state.transactions.find(t=>t.id===id);
  if (tr) {
    if (tr.cashPaid) applyCashMovement(tr.cashPaid, tr.cashChange, -1); // put the bills/coins back
    if (tr.receiptPath && window.SB) window.SB.deleteReceipt(tr.receiptPath);
    if (tr.receiptPendingLocal) deletePendingReceipt(tr.id);
  }
  state.transactions = state.transactions.filter(t=>t.id!==id); saveState(); closeSheet(); toast(t('deletedSuccess')); render();
}

/* ============================== REPORTS ============================== */
window.__reportTab = 'monthly';
function renderReports() {
  const tabs = [
    { id: 'monthly', lb: t('monthlyReport') }, { id: 'income', lb: t('incomeReport') },
    { id: 'expense', lb: t('expenseReport') }, { id: 'education', lb: t('educationReport') },
    { id: 'savings', lb: t('savingsReport') }, { id: 'comparison', lb: t('comparisonReport') },
  ];
  let body = '';
  if (window.__reportTab === 'monthly') body = reportMonthly();
  else if (window.__reportTab === 'income') body = reportIncome();
  else if (window.__reportTab === 'expense') body = reportExpense();
  else if (window.__reportTab === 'education') body = reportEducation();
  else if (window.__reportTab === 'savings') body = reportSavings();
  else if (window.__reportTab === 'comparison') body = reportComparison();
  return `<div class="tabs">${tabs.map(tb=>`<button class="tab-btn ${window.__reportTab===tb.id?'active':''}" onclick="window.__reportTab='${tb.id}'; render();">${tb.lb}</button>`).join('')}</div>${body}`;
}
function reportMonthly() {
  const inc = monthIncome(), exp = monthExpense(), sav = monthSaving();
  const byCat = {};
  monthTx().filter(t=>t.type==='expense').forEach(t => { byCat[t.envelopeId] = (byCat[t.envelopeId]||0) + t.amount; });
  const sorted = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const highest = sorted[0], lowest = sorted[sorted.length-1];
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate();
  const avgDaily = exp / new Date().getDate();
  return `
    <div class="card">
      <div class="list-row"><div class="mid t1">${t('income')}</div><div class="amt pos">+${fmt(inc)}</div></div>
      <div class="list-row"><div class="mid t1">${t('expenses')}</div><div class="amt neg">-${fmt(exp)}</div></div>
      <div class="list-row"><div class="mid t1">${t('netChange')}</div><div class="amt ${inc-exp>=0?'pos':'neg'}">${signedMoney(inc-exp)}</div></div>
      <div class="list-row"><div class="mid t1">${t('savingLbl')}</div><div class="amt neu">${fmt(sav)}</div></div>
      <div class="list-row"><div class="mid t1">${t('avgDaily')}</div><div class="amt neu">${fmt(avgDaily)}</div></div>
      ${highest ? `<div class="list-row"><div class="mid t1">${t('highestCategory')}</div><div class="amt neu">${envLabel(getEnvelope(highest[0])||{})} (${fmt(highest[1])})</div></div>`:''}
      ${lowest ? `<div class="list-row"><div class="mid t1">${t('lowestCategory')}</div><div class="amt neu">${envLabel(getEnvelope(lowest[0])||{})} (${fmt(lowest[1])})</div></div>`:''}
    </div>
    <button class="btn btn-outline" id="pdfExportBtn" onclick="exportMonthlyReportPDF()">📄 ${state.settings.language==='ar' ? 'تصدير التقرير PDF' : 'Export report as PDF'}</button>
  `;
}
function reportIncome() {
  const bySrc = {};
  monthTx().filter(t=>t.type==='income').forEach(t => bySrc[t.source] = (bySrc[t.source]||0) + t.amount);
  const total = Object.values(bySrc).reduce((a,b)=>a+b,0);
  const entries = Object.entries(bySrc).sort((a,b)=>b[1]-a[1]);
  return `
    <div class="section-head"><h2>${t('incomeSourcesChart')}</h2></div>
    ${entries.length===0 ? emptyState('📭', t('noTransactions'),'') : entries.map(([src,val]) => barRow(sourceLabel(src), val, total, 'var(--good)')).join('')}
    <canvas id="incomeChart" height="200" style="margin-top:10px;"></canvas>
  `;
}
function reportExpense() {
  const ar = isArabic(), off = window.__expOff || 0;
  const byCat = expByCat(off);
  const total = Object.values(byCat).reduce((a,b)=>a+b,0);
  const entries = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const older = ar ? '›' : '‹', newer = ar ? '‹' : '›';
  return `
    <div class="card" style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px;">
      <button class="step-btn" onclick="expMonthStep(1)">${older}</button>
      <div style="text-align:center;"><div style="font-weight:800; font-size:14px;">${monthLabel(off)}</div><div class="small-note">${t('expenses')}: ${fmt(total)} ${state.settings.currency}</div></div>
      <button class="step-btn" onclick="expMonthStep(-1)" ${off===0?'disabled':''}>${newer}</button>
    </div>
    <div class="btn-row" style="margin-bottom:6px;">
      <button class="btn btn-outline btn-sm" style="flex:1;" id="expPdfBtn" onclick="exportExpensePDF()">📄 PDF</button>
      <button class="btn btn-outline btn-sm" style="flex:1;" onclick="exportExpenseExcel()">📊 Excel</button>
    </div>
    <div class="section-head"><h2>${t('expenseCategoriesChart')}</h2></div>
    ${entries.length===0 ? emptyState('📭', t('noTransactions'),'') : entries.map(([envId,val]) => barRow(catName(envId), val, total, 'var(--bad)')).join('')}
    <canvas id="expenseChart" height="200" style="margin-top:10px;"></canvas>
  `;
}
function expMonthStep(d) { window.__expOff = Math.max(0, (window.__expOff||0) + d); render(); }
function barRow(label, val, total, color) {
  const pct = total > 0 ? Math.round((val/total)*100) : 0;
  return `<div class="report-bar-row"><div class="rl">${label}</div><div class="report-bar-track"><div class="report-bar-fill" style="width:${pct}%; background:${color};"></div></div><div class="rv">${fmt(val)}</div></div>`;
}
function reportEducation() {
  const booksTotal = state.books.reduce((a,b)=>a+b.received,0);
  const booksPaid = state.books.reduce((a,b)=>a+b.paid,0);
  const lessonsTotal = state.lessons.reduce((a,b)=>a+b.price,0);
  const lessonsPaid = state.lessons.filter(l=>l.status==='paid').reduce((a,b)=>a+b.price,0);
  return `
    <div class="card">
      <div class="list-row"><div class="mid t1">📚 ${t('books')} — ${t('total')}</div><div class="amt neu">${fmt(booksTotal)}</div></div>
      <div class="list-row"><div class="mid t1">📚 ${t('books')} — ${t('paidLbl')}</div><div class="amt neu">${fmt(booksPaid)}</div></div>
      <div class="list-row"><div class="mid t1">📚 ${t('books')} — ${t('remainingLbl')}</div><div class="amt neu">${fmt(booksTotal-booksPaid)}</div></div>
      <div class="list-row"><div class="mid t1">📝 ${t('lessons')} — ${t('total')}</div><div class="amt neu">${fmt(lessonsTotal)}</div></div>
      <div class="list-row"><div class="mid t1">📝 ${t('lessons')} — ${t('paidLbl')}</div><div class="amt neu">${fmt(lessonsPaid)}</div></div>
      <div class="list-row"><div class="mid t1">📝 ${t('lessons')} — ${t('remainingLbl')}</div><div class="amt neu">${fmt(lessonsTotal-lessonsPaid)}</div></div>
      <div class="list-row"><div class="mid t1">${t('totalEducation')}</div><div class="amt neu">${fmt(booksPaid+lessonsPaid)}</div></div>
    </div>
  `;
}
function reportSavings() {
  const totalSaved = state.savingsGoals.reduce((a,g)=>a+g.current,0);
  const active = state.savingsGoals.filter(g=>g.current<g.target).length;
  const completed = state.savingsGoals.filter(g=>g.current>=g.target && g.target>0).length;
  return `
    <div class="card">
      <div class="list-row"><div class="mid t1">${t('totalSaved')}</div><div class="amt neu">${fmt(totalSaved)}</div></div>
      <div class="list-row"><div class="mid t1">${t('savingLbl')} — ${t('thisMonth')}</div><div class="amt neu">${fmt(monthSaving(0))}</div></div>
      <div class="list-row"><div class="mid t1">${t('activeGoals')}</div><div class="amt neu">${active}</div></div>
      <div class="list-row"><div class="mid t1">${t('completedGoals')}</div><div class="amt neu">${completed}</div></div>
    </div>
    ${state.savingsGoals.map(goalCardHtml).join('')}
  `;
}
/* ---------- shared helpers for expense report / month comparison ---------- */
function monthKey(off) { const d = monthStart(off); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'); }
function monthLabel(off) { const d = monthStart(off); return t('months')[d.getMonth()] + ' ' + d.getFullYear(); }
function expByCat(off) {
  const o = {};
  monthTx(off).filter(x => x.type === 'expense').forEach(x => { const k = x.envelopeId || '_none'; o[k] = (o[k]||0) + x.amount; });
  return o;
}
function catName(id) { return id === '_none' ? (isArabic() ? 'بدون قسم' : 'No category') : envLabel(getEnvelope(id) || { name: id }); }
function cmpOffsets(n) { const a = []; for (let i = n-1; i >= 0; i--) a.push(i); return a; }   // oldest → newest
function cmpData(n) {
  const offs = cmpOffsets(n);
  const per = offs.map(o => expByCat(o));
  const ids = [...new Set(per.flatMap(p => Object.keys(p)))];
  const rows = ids.map(id => { const vals = per.map(p => p[id] || 0); return { id, name: catName(id), vals, total: vals.reduce((a,b)=>a+b,0) }; })
                  .sort((a,b) => b.total - a.total);
  return {
    offs, rows,
    labels: offs.map(monthLabel),
    exp: offs.map(o => monthExpense(o)),
    inc: offs.map(o => monthIncome(o)),
  };
}
function pctChange(cur, prev) { return prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null; }
function changeBadge(cur, prev) {
  const ar = isArabic(), p = pctChange(cur, prev), diff = cur - prev;
  if (diff === 0) return `<span style="color:var(--ink-soft);">＝</span>`;
  const up = diff > 0;
  return `<span style="color:var(--${up?'bad':'good'}); direction:ltr; unicode-bidi:plaintext;">${up?'▲':'▼'} ${fmt(Math.abs(diff))}${p!==null?` (${Math.abs(p)}%)`:''}</span>`;
}
function setCmpN(n) { window.__cmpN = n; render(); }

function reportComparison() {
  const ar = isArabic(), n = window.__cmpN || 6;
  const d = cmpData(n);
  const hasAny = d.exp.some(v => v > 0);
  const totalsRows = d.offs.slice().reverse().map(o => {
    const cur = monthExpense(o), prev = monthExpense(o+1);
    return `<div class="list-row"><div class="mid"><div class="t1">${monthLabel(o)}</div><div class="t2">${t('income')}: ${fmt(monthIncome(o))}</div></div><div style="text-align:left;"><div class="amt neg">${fmt(cur)}</div><div style="font-size:11px; font-weight:700;">${prev>0||cur>0?changeBadge(cur, prev):''}</div></div></div>`;
  }).join('');
  const shortHead = d.offs.map(o => { const x = monthStart(o); return `<th style="padding:7px 8px; font-size:11px; white-space:nowrap;">${t('months')[x.getMonth()]}<br><span style="opacity:.6;">${String(x.getFullYear()).slice(2)}</span></th>`; }).join('');
  const last = d.offs.length - 1;
  const tableRows = d.rows.map(r => {
    const cur = r.vals[last], prev = last > 0 ? r.vals[last-1] : 0;
    return `<tr><td style="padding:7px 8px; font-size:12px; font-weight:700; white-space:nowrap;">${r.name}</td>${r.vals.map(v=>`<td style="padding:7px 8px; text-align:center; font-size:12px; direction:ltr;">${v?fmt(v):'–'}</td>`).join('')}<td style="padding:7px 8px; text-align:center; font-size:12px; font-weight:800; direction:ltr;">${fmt(r.total)}</td><td style="padding:7px 8px; text-align:center; font-size:11px; white-space:nowrap;">${changeBadge(cur, prev)}</td></tr>`;
  }).join('');
  const totalRow = `<tr style="background:var(--paper); font-weight:800;"><td style="padding:8px;">${t('total')}</td>${d.exp.map(v=>`<td style="padding:8px; text-align:center; font-size:12px; direction:ltr;">${fmt(v)}</td>`).join('')}<td style="padding:8px; text-align:center; font-size:12px; direction:ltr;">${fmt(d.exp.reduce((a,b)=>a+b,0))}</td><td></td></tr>`;
  return `
    <div class="seg" style="margin-bottom:12px;">
      ${[3,6,12].map(k=>`<button class="${n===k?'active':''}" onclick="setCmpN(${k})">${ar?`آخر ${k} شهور`:`Last ${k} months`}</button>`).join('')}
    </div>
    <div class="btn-row" style="margin-bottom:12px;">
      <button class="btn btn-outline btn-sm" style="flex:1;" id="cmpPdfBtn" onclick="exportComparisonPDF()">📄 PDF</button>
      <button class="btn btn-outline btn-sm" style="flex:1;" onclick="exportComparisonExcel()">📊 Excel</button>
    </div>
    ${!hasAny ? emptyState('📭', t('noTransactions'),'') : `
    <div class="card"><div class="chart-box"><canvas id="cmpChart"></canvas></div></div>
    <div class="section-head"><h2>${ar?'إجمالي المصروفات لكل شهر':'Total spending per month'}</h2></div>
    <div class="card">${totalsRows}</div>
    <div class="section-head"><h2>${ar?'المصروفات حسب القسم':'Spending by category'}</h2></div>
    <div class="card" style="padding:0; overflow-x:auto;">
      <table style="border-collapse:collapse; width:100%; min-width:${180 + n*62}px; color:var(--ink);">
        <thead><tr style="background:var(--paper);"><th style="padding:7px 8px; text-align:start; font-size:11px;">${ar?'القسم':'Category'}</th>${shortHead}<th style="padding:7px 8px; font-size:11px;">${t('total')}</th><th style="padding:7px 8px; font-size:11px;">${ar?'عن الشهر اللي قبله':'vs prev.'}</th></tr></thead>
        <tbody>${tableRows}${totalRow}</tbody>
      </table>
    </div>`}
  `;
}
function drawComparisonChart() {
  if (currentScreen !== 'reports' || window.__reportTab !== 'comparison') return;
  const c = document.getElementById('cmpChart'); if (!c) return;
  const d = cmpData(window.__cmpN || 6), ar = isArabic();
  const ink = getComputedStyle(document.body).getPropertyValue('--ink').trim() || '#132420';
  const grid = getComputedStyle(document.body).getPropertyValue('--line').trim() || '#E4E3DA';
  mountChart('cmpChart', { type: 'bar',
    data: { labels: d.labels, datasets: [
      { label: t('income'), data: d.inc, backgroundColor: '#3F8F5F', borderRadius: 6 },
      { label: t('expenses'), data: d.exp, backgroundColor: '#C4514A', borderRadius: 6 },
    ] },
    options: { responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
      plugins: { legend: { labels: { color: ink } } },
      scales: { x: { ticks: { color: ink, maxRotation: 45 }, grid: { display: false } }, y: { ticks: { color: ink }, grid: { color: grid }, beginAtZero: true } } } });
}

/* ---------- Excel / PDF export (expense report + month comparison) ---------- */
function ensureXlsx(onReady, onFail) {
  if (window.XLSX) { onReady(); return; }
  const urls = ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'];
  const tryNext = (i) => {
    if (i >= urls.length) { onFail && onFail(); return; }
    const sc = document.createElement('script'); sc.src = urls[i];
    sc.onload = () => window.XLSX ? onReady() : tryNext(i+1);
    sc.onerror = () => { sc.remove(); tryNext(i+1); };
    document.head.appendChild(sc);
  };
  tryNext(0);
}
function exportToolsError() { toast(isArabic() ? 'تعذّر تحميل أدوات التصدير — تأكد إنك أونلاين وجرب تاني' : "Couldn't load the export tools — check your connection and try again"); }
function styleSheet(ws, widths, numFmt) {
  ws['!cols'] = widths.map(w => ({ wch: w }));
  Object.keys(ws).forEach(k => { if (k[0] !== '!' && ws[k].t === 'n') ws[k].z = numFmt || '#,##0.00'; });
}
function saveWorkbook(wb, filename) {
  if (isArabic()) wb.Workbook = { Views: [{ RTL: true }] };   // open right-to-left in Excel
  XLSX.writeFile(wb, filename);
}
function numCell(v, f) { return f ? { t: 'n', v, f } : { t: 'n', v }; }

function exportExpenseExcel() {
  ensureXlsx(() => {
    try {
      const ar = isArabic(), off = window.__expOff || 0, cur = state.settings.currency;
      const inc = monthIncome(off), exp = monthExpense(off), sav = monthSaving(off);
      const byCat = expByCat(off);
      const entries = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
      const wb = XLSX.utils.book_new();

      const sum = XLSX.utils.aoa_to_sheet([
        [ar ? 'تقرير المصروفات' : 'Expense report', monthLabel(off)],
        [],
        [t('income'), inc], [t('expenses'), exp], [t('netChange'), numCell(inc-exp, 'B3-B4')], [t('savingLbl'), sav],
        [ar ? 'العملة' : 'Currency', cur],
      ]);
      styleSheet(sum, [24, 18]); XLSX.utils.book_append_sheet(wb, sum, ar ? 'ملخص' : 'Summary');

      const catRows = [[ar ? 'القسم' : 'Category', ar ? 'المبلغ' : 'Amount', ar ? 'النسبة %' : 'Share %']];
      entries.forEach(([id, v], i) => catRows.push([catName(id), v, numCell(exp > 0 ? Math.round(v/exp*1000)/10 : 0)]));
      if (entries.length) catRows.push([t('total'), numCell(exp, `SUM(B2:B${entries.length+1})`), numCell(100)]);
      const cs = XLSX.utils.aoa_to_sheet(catRows); styleSheet(cs, [26, 16, 12]);
      XLSX.utils.book_append_sheet(wb, cs, ar ? 'الأقسام' : 'Categories');

      const txs = monthTx(off).filter(x => x.type === 'expense').sort((a,b) => String(a.date).localeCompare(String(b.date)));
      const txRows = [[t('date'), ar ? 'القسم' : 'Category', ar ? 'المحفظة' : 'Wallet', ar ? 'المبلغ' : 'Amount', ar ? 'الوصف' : 'Description']];
      txs.forEach(x => txRows.push([x.date, catName(x.envelopeId || '_none'), x.walletId ? walLabel(getWallet(x.walletId) || { name: '' }) : '', x.amount, x.description || x.note || '']));
      if (txs.length) txRows.push([t('total'), '', '', numCell(exp, `SUM(D2:D${txs.length+1})`), '']);
      const ts = XLSX.utils.aoa_to_sheet(txRows); styleSheet(ts, [12, 22, 16, 14, 34]);
      XLSX.utils.book_append_sheet(wb, ts, ar ? 'العمليات' : 'Transactions');

      saveWorkbook(wb, `flosy-expenses-${monthKey(off)}.xlsx`);
      toast(ar ? 'تم حفظ ملف Excel ✅' : 'Excel file saved ✅');
    } catch (e) { console.error(e); toast(isArabic() ? 'حصل خطأ أثناء تجهيز ملف Excel' : 'Something went wrong generating the Excel file'); }
  }, exportToolsError);
}

function exportComparisonExcel() {
  ensureXlsx(() => {
    try {
      const ar = isArabic(), n = window.__cmpN || 6, d = cmpData(n);
      const wb = XLSX.utils.book_new();
      const colL = i => XLSX.utils.encode_col(i);
      const head = [ar ? 'القسم' : 'Category', ...d.labels, t('total'), ar ? 'المتوسط الشهري' : 'Monthly avg'];
      const rows = [head];
      d.rows.forEach((r, i) => {
        const rn = i + 2;
        rows.push([r.name, ...r.vals, numCell(r.total, `SUM(B${rn}:${colL(n)}${rn})`), numCell(Math.round(r.total/n*100)/100, `AVERAGE(B${rn}:${colL(n)}${rn})`)]);
      });
      const last = d.rows.length + 1;
      rows.push([t('total'), ...d.exp.map((v, i) => numCell(v, `SUM(${colL(i+1)}2:${colL(i+1)}${last})`)), numCell(d.exp.reduce((a,b)=>a+b,0), `SUM(${colL(n+1)}2:${colL(n+1)}${last})`), '']);
      const ws = XLSX.utils.aoa_to_sheet(rows); styleSheet(ws, [24, ...d.labels.map(()=>13), 14, 16]);
      XLSX.utils.book_append_sheet(wb, ws, ar ? 'مقارنة الأقسام' : 'By category');

      const mrows = [[ar ? 'الشهر' : 'Month', t('income'), t('expenses'), t('netChange'), ar ? 'تغيّر المصروفات عن الشهر اللي قبله' : 'Expense change vs prev.', ar ? 'نسبة التغيّر %' : 'Change %']];
      d.offs.forEach((o, i) => {
        const rn = i + 2, prev = monthExpense(o+1), cur = d.exp[i], p = pctChange(cur, prev);
        mrows.push([d.labels[i], d.inc[i], d.exp[i], numCell(d.inc[i]-d.exp[i], `B${rn}-C${rn}`), cur - prev, p === null ? '' : numCell(p)]);
      });
      const ms = XLSX.utils.aoa_to_sheet(mrows); styleSheet(ms, [18, 14, 14, 14, 26, 16]);
      XLSX.utils.book_append_sheet(wb, ms, ar ? 'ملخص شهري' : 'Monthly totals');

      saveWorkbook(wb, `flosy-comparison-${monthKey(n-1)}_to_${monthKey(0)}.xlsx`);
      toast(ar ? 'تم حفظ ملف Excel ✅' : 'Excel file saved ✅');
    } catch (e) { console.error(e); toast(isArabic() ? 'حصل خطأ أثناء تجهيز ملف Excel' : 'Something went wrong generating the Excel file'); }
  }, exportToolsError);
}

// Same approach as the monthly PDF: render styled HTML off-screen → html2canvas → paginate into jsPDF
async function htmlToPdf(innerHtml, filename, btnId, width, drawCharts) {
  const ar = isArabic();
  if (!window.html2canvas || !(window.jspdf && window.jspdf.jsPDF)) { exportToolsError(); return; }
  const btn = document.getElementById(btnId), oldLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = ar ? '...جاري التجهيز' : 'Preparing...'; }
  try {
    const box = document.createElement('div');
    box.dir = ar ? 'rtl' : 'ltr';
    box.style.cssText = `position:fixed; left:-9999px; top:0; width:${width}px; background:#F7F7F3; padding:26px; font-family:Cairo, system-ui, sans-serif; color:#132420;`;
    box.innerHTML = innerHtml;
    document.body.appendChild(box);
    if (drawCharts && window.Chart) drawCharts(box);
    await new Promise(r => setTimeout(r, 250));
    const canvas = await html2canvas(box, { scale: 2, backgroundColor: '#F7F7F3' });
    document.body.removeChild(box);
    const pdf = new window.jspdf.jsPDF('p', 'pt', 'a4');
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    const ih = canvas.height * pw / canvas.width, img = canvas.toDataURL('image/png');
    let left = ih, pos = 0;
    pdf.addImage(img, 'PNG', 0, pos, pw, ih); left -= ph;
    while (left > 0) { pos -= ph; pdf.addPage(); pdf.addImage(img, 'PNG', 0, pos, pw, ih); left -= ph; }
    pdf.save(filename);
    toast(ar ? 'تم حفظ ملف PDF ✅' : 'PDF saved ✅');
  } catch (e) { console.error(e); toast(ar ? 'حصل خطأ أثناء تجهيز الـ PDF' : 'Something went wrong generating the PDF'); }
  finally { const b = document.getElementById(btnId); if (b) { b.disabled = false; b.textContent = oldLabel; } }
}
function pdfHeader(title, sub) {
  return `<div style="text-align:center; margin-bottom:18px;"><div style="font-size:30px;">💸</div><div style="font-size:20px; font-weight:900;">Flosy</div><div style="font-size:14px; color:#4A5D57; font-weight:700; margin-top:2px;">${title} — ${sub}</div></div>`;
}
function pdfFooter() { return `<div style="text-align:center; margin-top:20px; font-size:10.5px; color:#4A5D57;">Flosy · ${new Date().toLocaleDateString(isArabic()?'ar-EG':'en-US')}</div>`; }

function exportExpensePDF() {
  const ar = isArabic(), off = window.__expOff || 0;
  const inc = monthIncome(off), exp = monthExpense(off), sav = monthSaving(off);
  const entries = Object.entries(expByCat(off)).sort((a,b)=>b[1]-a[1]);
  const catRows = entries.map(([id, v]) => pdfRow(`${catName(id)} <span style="color:#4A5D57; font-weight:600;">(${exp>0?Math.round(v/exp*100):0}%)</span>`, fmt(v), '#C4514A')).join('');
  const html = `
    ${pdfHeader(ar ? 'تقرير المصروفات' : 'Expense report', monthLabel(off))}
    <div style="border:1px solid #E4E3DA; border-radius:14px; overflow:hidden; margin-bottom:16px;">
      ${pdfRow(t('income'), fmt(inc), '#3F8F5F')}${pdfRow(t('expenses'), fmt(exp), '#C4514A')}
      ${pdfRow(t('netChange'), signedMoney(inc-exp), inc-exp>=0?'#3F8F5F':'#C4514A')}${pdfRow(t('savingLbl'), fmt(sav), '#7C6BA8')}
    </div>
    ${entries.length ? `<div style="font-size:14px; font-weight:800; margin:14px 0 8px;">${t('expenseCategoriesChart')}</div>
    <div style="border:1px solid #E4E3DA; border-radius:14px; overflow:hidden; margin-bottom:16px;">${catRows}</div>
    <canvas id="pdfExpCat" width="500" height="240"></canvas>` : `<div style="text-align:center; padding:24px; color:#4A5D57;">${t('noTransactions')}</div>`}
    ${pdfFooter()}`;
  htmlToPdf(html, `flosy-expenses-${monthKey(off)}.pdf`, 'expPdfBtn', 560, box => {
    const c = box.querySelector('#pdfExpCat'); if (!c) return;
    new Chart(c, { type: 'doughnut', data: { labels: entries.map(([id]) => catName(id)), datasets: [{ data: entries.map(([,v]) => v), backgroundColor: ['#C4514A','#E8A33D','#2F6F5E','#7C6BA8','#3F8F5F','#4A5D57','#D98A2B','#20362F'] }] }, options: { animation: false, plugins: { legend: { labels: { color: '#132420' } } } } });
  });
}

function exportComparisonPDF() {
  const ar = isArabic(), n = window.__cmpN || 6, d = cmpData(n), last = n - 1;
  const th = 'padding:7px 6px; font-size:10.5px; background:#fff; border-bottom:1px solid #E4E3DA;';
  const td = 'padding:7px 6px; font-size:11px; text-align:center; border-bottom:1px solid #E4E3DA; background:#fff; direction:ltr;';
  const head = d.offs.map((o,i) => { const x = monthStart(o); return `<th style="${th}">${t('months')[x.getMonth()]}<br>${String(x.getFullYear()).slice(2)}</th>`; }).join('');
  const body = d.rows.map(r => `<tr><td style="${td} text-align:start; font-weight:700; direction:inherit;">${r.name}</td>${r.vals.map(v=>`<td style="${td}">${v?fmt(v):'–'}</td>`).join('')}<td style="${td} font-weight:800;">${fmt(r.total)}</td></tr>`).join('');
  const totals = `<tr><td style="${td} text-align:start; font-weight:800; direction:inherit;">${t('total')}</td>${d.exp.map(v=>`<td style="${td} font-weight:800;">${fmt(v)}</td>`).join('')}<td style="${td} font-weight:800;">${fmt(d.exp.reduce((a,b)=>a+b,0))}</td></tr>`;
  const monthRows = d.offs.slice().reverse().map(o => { const cur = monthExpense(o), prev = monthExpense(o+1), diff = cur - prev;
    return pdfRow(monthLabel(o), `${fmt(cur)}${prev>0||cur>0?` &nbsp;<span style="font-size:11px; color:${diff>0?'#C4514A':'#3F8F5F'};">${diff>0?'▲':diff<0?'▼':'＝'} ${fmt(Math.abs(diff))}</span>`:''}`, '#C4514A'); }).join('');
  const html = `
    ${pdfHeader(ar ? 'مقارنة المصروفات بين الشهور' : 'Monthly expense comparison', `${d.labels[0]} → ${d.labels[last]}`)}
    <canvas id="pdfCmp" width="640" height="260"></canvas>
    <div style="font-size:14px; font-weight:800; margin:16px 0 8px;">${ar?'إجمالي المصروفات لكل شهر':'Total spending per month'}</div>
    <div style="border:1px solid #E4E3DA; border-radius:14px; overflow:hidden; margin-bottom:16px;">${monthRows}</div>
    <div style="font-size:14px; font-weight:800; margin:16px 0 8px;">${ar?'المصروفات حسب القسم':'Spending by category'}</div>
    <div style="border:1px solid #E4E3DA; border-radius:14px; overflow:hidden;"><table style="border-collapse:collapse; width:100%;"><thead><tr><th style="${th} text-align:start;">${ar?'القسم':'Category'}</th>${head}<th style="${th}">${t('total')}</th></tr></thead><tbody>${body}${totals}</tbody></table></div>
    ${pdfFooter()}`;
  htmlToPdf(html, `flosy-comparison-${monthKey(n-1)}_to_${monthKey(0)}.pdf`, 'cmpPdfBtn', 720, box => {
    const c = box.querySelector('#pdfCmp'); if (!c) return;
    new Chart(c, { type: 'bar', data: { labels: d.labels, datasets: [{ label: t('income'), data: d.inc, backgroundColor: '#3F8F5F' }, { label: t('expenses'), data: d.exp, backgroundColor: '#C4514A' }] }, options: { animation: false, plugins: { legend: { labels: { color: '#132420' } } } } });
  });
}

/* ------------------------------ Monthly report PDF export ------------------------------ */
// Renders a standalone, print-styled copy of the monthly report off-screen, snapshots it
// with html2canvas (so Arabic text/RTL renders exactly as the browser lays it out — jsPDF's
// own text drawing doesn't shape Arabic correctly), then drops that image into a jsPDF file,
// slicing across pages if the content is taller than one A4 page.
async function exportMonthlyReportPDF() {
  if (!window.html2canvas || !(window.jspdf && window.jspdf.jsPDF)) {
    toast(state.settings.language==='ar' ? 'تعذّر تحميل أدوات التصدير — تأكد إنك أونلاين وجرب تاني' : "Couldn't load the export tools — check your connection and try again");
    return;
  }
  const isAr = state.settings.language === 'ar';
  const btn = document.getElementById('pdfExportBtn');
  if (btn) { btn.disabled = true; btn.textContent = isAr ? '...جاري تجهيز الـ PDF' : 'Preparing PDF...'; }
  try {
    const inc = monthIncome(), exp = monthExpense(), sav = monthSaving();
    const bySrc = {}; monthTx().filter(x=>x.type==='income').forEach(x => bySrc[x.source] = (bySrc[x.source]||0) + x.amount);
    const byCat = {}; monthTx().filter(x=>x.type==='expense').forEach(x => byCat[x.envelopeId] = (byCat[x.envelopeId]||0) + x.amount);
    const sorted = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
    const highest = sorted[0], lowest = sorted[sorted.length-1];
    const avgDaily = exp / new Date().getDate();
    const monthName = t('months')[new Date().getMonth()];
    const year = new Date().getFullYear();

    const container = document.createElement('div');
    container.dir = isAr ? 'rtl' : 'ltr';
    container.style.cssText = 'position:fixed; left:-9999px; top:0; width:560px; background:#F7F7F3; padding:26px; font-family:Cairo, system-ui, sans-serif; color:#132420;';
    container.innerHTML = `
      <div style="text-align:center; margin-bottom:18px;">
        <div style="font-size:30px;">💸</div>
        <div style="font-size:20px; font-weight:900;">Flosy</div>
        <div style="font-size:14px; color:#4A5D57; font-weight:700; margin-top:2px;">${isAr?'التقرير الشهري':'Monthly report'} — ${monthName} ${year}</div>
      </div>
      <div style="border:1px solid #E4E3DA; border-radius:14px; overflow:hidden; margin-bottom:16px;">
        ${pdfRow(t('income'), fmt(inc), '#3F8F5F')}
        ${pdfRow(t('expenses'), fmt(exp), '#C4514A')}
        ${pdfRow(t('netChange'), signedMoney(inc-exp), inc-exp>=0?'#3F8F5F':'#C4514A')}
        ${pdfRow(t('savingLbl'), fmt(sav), '#7C6BA8')}
        ${pdfRow(t('avgDaily'), fmt(avgDaily), '#4A5D57')}
        ${highest ? pdfRow(t('highestCategory'), `${envLabel(getEnvelope(highest[0])||{})} (${fmt(highest[1])})`, '#4A5D57') : ''}
        ${lowest ? pdfRow(t('lowestCategory'), `${envLabel(getEnvelope(lowest[0])||{})} (${fmt(lowest[1])})`, '#4A5D57') : ''}
      </div>
      ${Object.keys(bySrc).length ? `<div style="font-size:14px; font-weight:800; margin:14px 0 8px;">${t('incomeSourcesChart')}</div><canvas id="pdfIncomeChart" width="500" height="240"></canvas>` : ''}
      ${Object.keys(byCat).length ? `<div style="font-size:14px; font-weight:800; margin:18px 0 8px;">${t('expenseCategoriesChart')}</div><canvas id="pdfExpenseChart" width="500" height="240"></canvas>` : ''}
      <div style="text-align:center; margin-top:20px; font-size:10.5px; color:#4A5D57;">Flosy · ${new Date().toLocaleDateString(isAr?'ar-EG':'en-US')}</div>
    `;
    document.body.appendChild(container);

    if (window.Chart) {
      const incCanvas = container.querySelector('#pdfIncomeChart');
      const expCanvas = container.querySelector('#pdfExpenseChart');
      if (incCanvas) new Chart(incCanvas, { type: 'doughnut', data: { labels: Object.keys(bySrc).map(s=>sourceLabel(s)), datasets: [{ data: Object.values(bySrc), backgroundColor: ['#2F6F5E','#E8A33D','#7C6BA8','#3F8F5F','#C4514A','#4A5D57'] }] }, options: { animation: false, plugins: { legend: { labels: { color: '#132420' } } } } });
      if (expCanvas) new Chart(expCanvas, { type: 'doughnut', data: { labels: Object.keys(byCat).map(id=>envLabel(getEnvelope(id)||{name:id})), datasets: [{ data: Object.values(byCat), backgroundColor: ['#C4514A','#E8A33D','#2F6F5E','#7C6BA8','#3F8F5F','#4A5D57','#D98A2B','#20362F'] }] }, options: { animation: false, plugins: { legend: { labels: { color: '#132420' } } } } });
    }
    await new Promise(r => setTimeout(r, 200)); // let fonts/canvases paint before the snapshot

    const canvas = await html2canvas(container, { scale: 2, backgroundColor: '#F7F7F3' });
    document.body.removeChild(container);

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'pt', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = canvas.height * imgWidth / canvas.width;
    const imgData = canvas.toDataURL('image/png');
    let heightLeft = imgHeight, position = 0;
    pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
    while (heightLeft > 0) {
      position -= pageHeight;
      pdf.addPage();
      pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }
    pdf.save(`flosy-report-${monthName}-${year}.pdf`);
  } catch (err) {
    toast(isAr ? 'حصل خطأ أثناء تجهيز الـ PDF' : 'Something went wrong generating the PDF');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = `📄 ${isAr ? 'تصدير التقرير PDF' : 'Export report as PDF'}`; }
  }
}
function pdfRow(label, value, color) {
  return `<div style="display:flex; align-items:center; justify-content:space-between; padding:11px 14px; border-bottom:1px solid #E4E3DA; background:#fff;">
    <div style="font-size:13px; font-weight:700;">${label}</div>
    <div style="font-size:13.5px; font-weight:800; color:${color}; direction:ltr;">${value}</div>
  </div>`;
}

function runDeferredCharts() {
  destroyCharts();
  if (currentScreen === 'analytics') { runAnalyticsCharts(); return; }
  if (window.__reportTab === 'comparison' && document.getElementById('cmpChart')) { ensureChartJs(drawComparisonChart, () => chartEmpty('cmpChart')); return; }
  if (window.__reportTab === 'income' && document.getElementById('incomeChart') && window.Chart) {
    const bySrc = {}; monthTx().filter(t=>t.type==='income').forEach(t => bySrc[t.source] = (bySrc[t.source]||0) + t.amount);
    new Chart(document.getElementById('incomeChart'), { type: 'doughnut', data: { labels: Object.keys(bySrc).map(s=>sourceLabel(s)), datasets: [{ data: Object.values(bySrc), backgroundColor: ['#2F6F5E','#E8A33D','#7C6BA8','#3F8F5F','#C4514A','#4A5D57'] }] }, options: { plugins: { legend: { labels: { color: getComputedStyle(document.body).getPropertyValue('--ink') } } } } });
  }
  if (window.__reportTab === 'expense' && document.getElementById('expenseChart') && window.Chart) {
    const byCat = {}; monthTx(window.__expOff||0).filter(t=>t.type==='expense').forEach(t => byCat[t.envelopeId] = (byCat[t.envelopeId]||0) + t.amount);
    new Chart(document.getElementById('expenseChart'), { type: 'doughnut', data: { labels: Object.keys(byCat).map(id=>catName(id)), datasets: [{ data: Object.values(byCat), backgroundColor: ['#C4514A','#E8A33D','#2F6F5E','#7C6BA8','#3F8F5F','#4A5D57','#D98A2B','#20362F'] }] }, options: { plugins: { legend: { labels: { color: getComputedStyle(document.body).getPropertyValue('--ink') } } } } });
  }
}

/* ============================== MORE / SETTINGS ============================== */
function renderMore() {
  const items = [
    { ic: '🔮', lb: state.settings.language==='ar'?'التحليلات الذكية':'Smart Analytics', fn: "nav('analytics')" },
    { ic: '✨', lb: state.settings.language==='ar'?'إضافة سريعة بالذكاء':'Quick Smart Add', fn: "nav('quickAdd')" },
    { ic: '💵', lb: t('cashManager'), fn: "nav('cashManager')" },
    { ic: '🚍', lb: t('transportRoutes'), fn: "nav('transportRoutes')" },
    { ic: '📊', lb: t('transportReport'), fn: "nav('transportReport')" },
    { ic: '🤝', lb: t('owedToYou'), fn: "nav('owedToYou')" },
    { ic: '📅', lb: t('upcomingMoney'), fn: "nav('upcoming')" },
    { ic: '📚', lb: t('books_title'), fn: "nav('books')" },
    { ic: '📝', lb: t('lessons_title'), fn: "nav('lessons')" },
    { ic: '👛', lb: t('wallets'), fn: "nav('wallets')" },
    { ic: '🎯', lb: t('savingsGoals'), fn: "nav('goals')" },
    { ic: '📌', lb: t('plannedExpenses'), fn: "nav('planned')" },
    { ic: '🧠', lb: t('whereIsMoney'), fn: "nav('whereIsMoney')" },
    { ic: '🤔', lb: t('canIBuy'), fn: "nav('canIBuy')" },
    { ic: '🪣', lb: t('manageEnvelopes'), fn: "nav('envelopes')" },
    { ic: '⚙️', lb: t('settingsLbl'), fn: "nav('settings')" },
  ];
  return `<div class="card">${items.map(i => `
    <div class="list-row" style="cursor:pointer;" onclick="${i.fn}">
      <div class="ico-badge">${i.ic}</div><div class="mid t1">${i.lb}</div><div class="amt neu">›</div>
    </div>`).join('')}</div>`;
}

function renderSettings() {
  return `
    <div class="card">
      <div class="settings-row"><div><div class="st">${t('currencyLbl')}</div></div>
        <select onchange="setSetting('currency', this.value)" style="padding:8px 10px; border-radius:8px; border:1px solid var(--line); background:var(--paper);">
          ${['EGP','USD','SAR','AED','EUR'].map(c=>`<option value="${c}" ${state.settings.currency===c?'selected':''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="settings-row"><div><div class="st">${t('languageLbl')}</div></div>
        <div class="seg" style="width:140px;">
          <button class="${state.settings.language==='ar'?'active':''}" onclick="setSetting('language','ar')">العربية</button>
          <button class="${state.settings.language==='en'?'active':''}" onclick="setSetting('language','en')">EN</button>
        </div>
      </div>
      <div class="settings-row"><div><div class="st">${t('themeLbl')}</div></div>
        <div class="seg" style="width:140px;">
          <button class="${state.settings.theme==='light'?'active':''}" onclick="setSetting('theme','light')">☀️</button>
          <button class="${state.settings.theme==='dark'?'active':''}" onclick="setSetting('theme','dark')">🌙</button>
        </div>
      </div>
      <div class="settings-row"><div><div class="st">${t('pinLock')}</div><div class="ss">${state.settings.pin ? '••••' : '—'}</div></div>
        <button class="switch ${state.settings.pin?'on':''}" onclick="togglePin()"></button>
      </div>
      <div class="settings-row"><div><div class="st">🔔 ${state.settings.language==='ar'?'تنبيهات المتصفح':'Browser notifications'}</div>
        <div class="ss">${state.settings.language==='ar'?'تعمل وقت ما التطبيق مفتوح على الجهاز':'Works while the app is open on this device'}</div></div>
        <button class="switch ${notificationsEnabled()?'on':''}" onclick="requestNotificationPermission()"></button>
      </div>
    </div>
    <div class="card">
      <div class="settings-row" style="cursor:pointer;" onclick="nav('wallets')"><div class="st">${t('manageWallets')}</div><div class="amt neu">›</div></div>
      <div class="settings-row" style="cursor:pointer;" onclick="nav('envelopes')"><div class="st">${t('manageEnvelopes')}</div><div class="amt neu">›</div></div>
    </div>
    <div class="card">
      <div class="settings-row" style="cursor:pointer;" onclick="exportBackup()"><div class="st">${t('exportBackup')}</div><div class="amt neu">⬇️</div></div>
      <div class="settings-row" style="cursor:pointer;" onclick="document.getElementById('importFile').click()"><div class="st">${t('importBackup')}</div><div class="amt neu">⬆️</div></div>
      <input type="file" id="importFile" accept=".json" style="display:none;" onchange="importBackup(this)">
      <div class="settings-row" style="cursor:pointer;" onclick="exportCSV()"><div class="st">${t('exportTransactions')}</div><div class="amt neu">📄</div></div>
    </div>
    <div class="card">
      <div class="settings-row" style="cursor:pointer;" onclick="switchProfile()"><div class="st">👤 ${state.settings.language==='ar'?'تسجيل الخروج':'Sign out'}</div><div class="amt neu">›</div></div>
      ${window.__userEmail ? `<div class="settings-row"><div class="st">📧 ${window.__userEmail}</div></div>` : ''}
      ${googleLinkRowHtml()}
      <div class="settings-row" style="cursor:pointer;" onclick="resetApp()"><div class="st" style="color:var(--bad);">${t('resetApp')}</div></div>
    </div>
    <p class="small-note" style="text-align:center; margin-top:6px;">🔒 ${t('offlineNote')}</p>
    <p class="small-note" style="text-align:center;">${t('appName')} · v1.0</p>
  `;
}
function setSetting(key, val) { state.settings[key] = val; saveState(); render(); }
function togglePin() {
  if (state.settings.pin) { state.settings.pin = null; saveState(); toast(t('savedSuccess')); render(); return; }
  window.__pinSetupBuffer = '';
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('setPin')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="pin-dots" id="pinSetupDots">${[0,1,2,3].map(()=>'<div class="pin-dot"></div>').join('')}</div>
    <div class="pin-pad">
      ${[1,2,3,4,5,6,7,8,9].map(n=>`<button class="pin-key" onclick="pinSetupPress('${n}')">${n}</button>`).join('')}
      <div></div><button class="pin-key" onclick="pinSetupPress('0')">0</button>
      <button class="pin-key" onclick="pinSetupPress('back')">⌫</button>
    </div>
  `);
}
function pinSetupPress(k) {
  if (k === 'back') { window.__pinSetupBuffer = window.__pinSetupBuffer.slice(0,-1); }
  else if (window.__pinSetupBuffer.length < 4) { window.__pinSetupBuffer += k; }
  document.getElementById('pinSetupDots').innerHTML = [0,1,2,3].map(i=>`<div class="pin-dot ${window.__pinSetupBuffer.length>i?'filled':''}"></div>`).join('');
  if (window.__pinSetupBuffer.length === 4) {
    setTimeout(() => { state.settings.pin = window.__pinSetupBuffer; saveState(); window.__unlocked = true; closeSheet(); toast(t('savedSuccess')); render(); }, 150);
  }
}

/* ------------------------------ Backup ------------------------------ */
function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `mywallet-backup-${todayStr()}.json`; a.click();
  URL.revokeObjectURL(url);
}
function importBackup(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      state = Object.assign(freshState(), data);
      saveState(); toast(t('savedSuccess')); render();
    } catch (err) { toast(state.settings.language==='ar' ? 'الملف مش صالح' : 'Invalid backup file'); }
  };
  reader.readAsText(file);
}
function exportCSV() {
  const rows = [['date','type','category','wallet','amount','description']];
  state.transactions.forEach(tr => {
    rows.push([tr.date, tr.type, tr.envelopeId ? envLabel(getEnvelope(tr.envelopeId)||{name:tr.envelopeId}) : (tr.source||''), tr.walletId ? walLabel(getWallet(tr.walletId)||{name:''}) : '', tr.amount, (tr.description||tr.note||'').replace(/,/g,';')]);
  });
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `transactions-${todayStr()}.csv`; a.click();
  URL.revokeObjectURL(url);
}
function resetApp() {
  if (!confirm(t('resetConfirm'))) return;
  state = freshState(); window.__unlocked = false;
  saveState(); nav('dashboard');
}

/* ============================== INIT ============================== */
window.__unlocked = false;
document.addEventListener('DOMContentLoaded', () => {
  if (!window.FB) {
    // firebase-init.js failed to load/execute (offline, blocked script, bad config...)
    render();
    return;
  }
  window.FB.onAuthChange(async (user) => {
    if (user) {
      window.__uid = user.uid;
      window.__userEmail = user.email || '';
      state = loadLocalCache(user.uid) || freshState(); // instant paint from cache if we have one
      window.__unlocked = false;
      currentScreen = 'dashboard';
      render();
      await hydrateStateFromCloud(user.uid); // then reconcile with Firestore
      render();
      flushPendingReceipts(); // retry any receipts that couldn't upload last time (fire-and-forget)
    } else {
      window.__uid = null;
      state = freshState();
      render();
    }
  });
  scheduleReminderCheck();
});

/* ============================== ANALYTICS ============================== */
function daysInCurrentMonth() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth()+1, 0).getDate(); }
function dayOfMonth() { return new Date().getDate(); }

function projectedEndOfMonthBalance() {
  const av = availableMoney();
  const exp = monthExpense(0);
  const dom = dayOfMonth();
  const dim = daysInCurrentMonth();
  const dailyRate = dom > 0 ? exp / dom : 0;
  const daysLeft = dim - dom;
  const projectedFurtherSpend = dailyRate * daysLeft;
  return { projected: av - projectedFurtherSpend, dailyRate, daysLeft, projectedFurtherSpend };
}
function savingsRate() {
  const inc = monthIncome(0);
  const sav = monthSaving(0);
  return inc > 0 ? Math.round((sav / inc) * 100) : 0;
}
function top5Categories() {
  const byCat = {};
  monthTx(0).filter(t=>t.type==='expense').forEach(t => byCat[t.envelopeId] = (byCat[t.envelopeId]||0) + t.amount);
  return Object.entries(byCat).sort((a,b)=>b[1]-a[1]).slice(0,5);
}

function renderAnalytics() {
  const proj = projectedEndOfMonthBalance();
  const rate = savingsRate();
  const top5 = top5Categories();
  const isAr = state.settings.language === 'ar';
  const projLine = isAr
    ? `لو استمريت بنفس معدل الصرف الحالي (${fmt(proj.dailyRate)} ${state.settings.currency}/يوم)، هيفضل معاك تقريبًا <b>${fmt(proj.projected)} ${state.settings.currency}</b> آخر الشهر.`
    : `If your current spending pace continues (${fmt(proj.dailyRate)} ${state.settings.currency}/day), you'll likely have about <b>${fmt(proj.projected)} ${state.settings.currency}</b> left by month end.`;

  return `
    <div class="card" style="background:linear-gradient(155deg, var(--primary) 0%, var(--primary-2) 100%); color:#F5FBF8; border:none;">
      <div style="font-size:13px; font-weight:700; opacity:.9; margin-bottom:6px;">🔮 ${isAr?'توقع نهاية الشهر':'End-of-month projection'}</div>
      <div style="font-size:14.5px; line-height:1.8;">${projLine}</div>
    </div>

    <div class="month-row">
      <div class="month-card"><div class="v">${rate}%</div><div class="l">${isAr?'معدل التوفير':'Savings rate'}</div></div>
      <div class="month-card"><div class="v">${fmt(proj.dailyRate)}</div><div class="l">${isAr?'متوسط صرف يومي':'Avg daily spend'}</div></div>
      <div class="month-card"><div class="v">${proj.daysLeft}</div><div class="l">${isAr?'أيام متبقية':'Days left'}</div></div>
    </div>

    <div class="section-head"><h2>${isAr?'أين يذهب المال أكثر؟':'Where does your money go?'}</h2>
      <button class="link" onclick="exportChartImg('analyticsCatChart','category-breakdown')">⬇️ PNG</button></div>
    <div class="card"><div class="chart-box"><canvas id="analyticsCatChart"></canvas></div></div>

    <div class="section-head"><h2>${isAr?'مقارنة هذا الشهر بالشهر الماضي':'This month vs last month'}</h2>
      <button class="link" onclick="exportChartImg('analyticsCompareChart','month-comparison')">⬇️ PNG</button></div>
    <div class="card"><div class="chart-box"><canvas id="analyticsCompareChart"></canvas></div></div>

    <div class="section-head"><h2>${isAr?'أعلى 5 فئات صرفًا':'Top 5 spending categories'}</h2></div>
    <div class="card">
      ${top5.length===0 ? emptyState('📭', t('noTransactions'),'') :
        top5.map(([id,val],i) => `
        <div class="list-row">
          <div class="ico-badge">${i+1}</div>
          <div class="mid t1">${getEnvelope(id) ? getEnvelope(id).icon+' '+envLabel(getEnvelope(id)) : id}</div>
          <div class="amt neu">${fmt(val)} ${state.settings.currency}</div>
        </div>`).join('')}
    </div>

    <div class="section-head"><h2>${isAr?'اتجاه الصرف خلال آخر 6 شهور':'Spending trend — last 6 months'}</h2>
      <button class="link" onclick="exportChartImg('analyticsTrendChart','spending-trend')">⬇️ PNG</button></div>
    <div class="card"><div class="chart-box"><canvas id="analyticsTrendChart"></canvas></div></div>
  `;
}
function exportChartImg(canvasId, filename) {
  const c = document.getElementById(canvasId);
  if (!c || !c.__chart) { toast(state.settings.language==='ar'?'الرسم لسه بيتحمّل':'Chart still loading'); return; }
  const url = c.__chart.toBase64Image();
  const a = document.createElement('a'); a.href = url; a.download = `${filename}-${todayStr()}.png`; a.click();
}
function chartColors() {
  return ['#2F6F5E','#E8A33D','#7C6BA8','#C4514A','#3F8F5F','#D98A2B','#4A5D57','#20362F','#8FBFA8'];
}
/* Chart.js loader: if the <script> in index.html failed (slow/blocked CDN) we
   try other CDNs instead of silently drawing nothing. */
function ensureChartJs(onReady, onFail) {
  if (window.Chart) { onReady(); return; }
  if (window.__chartLoading) { window.__chartLoading.push([onReady, onFail]); return; }
  window.__chartLoading = [[onReady, onFail]];
  const urls = [
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js',
  ];
  const finish = (ok) => { const q = window.__chartLoading || []; window.__chartLoading = null; q.forEach(([a, b]) => { try { (ok ? a : b) && (ok ? a : b)(); } catch (e) { console.error(e); } }); };
  const tryNext = (i) => {
    if (i >= urls.length) { finish(false); return; }
    const sc = document.createElement('script'); sc.src = urls[i];
    sc.onload = () => { window.Chart ? finish(true) : tryNext(i + 1); };
    sc.onerror = () => { sc.remove(); tryNext(i + 1); };
    document.head.appendChild(sc);
  };
  tryNext(0);
}
function destroyCharts() {
  (window.__charts || []).forEach(c => { try { c.destroy(); } catch (e) { /* already gone */ } });
  window.__charts = [];
}
function mountChart(canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  try {
    const c = new Chart(canvas, config);
    canvas.__chart = c;
    (window.__charts = window.__charts || []).push(c);
    return c;
  } catch (e) {
    console.error('Chart failed:', canvasId, e);
    const box = canvas.parentElement;
    if (box) box.innerHTML = emptyState('⚠️', state.settings.language==='ar' ? 'تعذّر رسم الشكل' : "Couldn't draw this chart", '');
    return null;
  }
}
function chartEmpty(canvasId) {
  const c = document.getElementById(canvasId);
  if (c && c.parentElement) c.parentElement.innerHTML = emptyState('📭', t('noTransactions'), '');
}
function runAnalyticsCharts() {
  const ids = ['analyticsCatChart', 'analyticsCompareChart', 'analyticsTrendChart'];
  if (!ids.some(id => document.getElementById(id))) return;
  ensureChartJs(drawAnalyticsCharts, () => {
    const ar = state.settings.language === 'ar';
    ids.forEach(id => {
      const c = document.getElementById(id);
      if (c && c.parentElement) c.parentElement.innerHTML = `<div class="empty-state"><div class="e-ico">📡</div><div class="e-t">${ar ? 'تعذّر تحميل مكتبة الرسوم' : "Couldn't load the chart library"}</div><div class="e-s">${ar ? 'تأكد من النت' : 'Check your connection'}</div><button class="btn btn-outline btn-sm" style="margin-top:10px;" onclick="render()">${ar ? 'إعادة المحاولة' : 'Retry'}</button></div>`;
    });
  });
}
function drawAnalyticsCharts() {
  if (currentScreen !== 'analytics') return;
  destroyCharts();
  const ink = getComputedStyle(document.body).getPropertyValue('--ink').trim() || '#132420';
  const grid = getComputedStyle(document.body).getPropertyValue('--line').trim() || '#E4E3DA';
  const base = { responsive: true, maintainAspectRatio: false, animation: { duration: 350 } };
  const axes = { x: { ticks: { color: ink }, grid: { color: grid } }, y: { beginAtZero: true, ticks: { color: ink }, grid: { color: grid } } };
  const nameOf = id => getEnvelope(id) ? envLabel(getEnvelope(id)) : id;

  // 1) where does money go
  const byCat = {};
  monthTx(0).filter(x => x.type === 'expense').forEach(x => byCat[x.envelopeId] = (byCat[x.envelopeId] || 0) + x.amount);
  if (Object.keys(byCat).length === 0) chartEmpty('analyticsCatChart');
  else mountChart('analyticsCatChart', { type: 'pie', data: { labels: Object.keys(byCat).map(nameOf), datasets: [{ data: Object.values(byCat), backgroundColor: chartColors() }] },
    options: Object.assign({}, base, { plugins: { legend: { position: 'bottom', labels: { color: ink, boxWidth: 12, font: { size: 11 } } } } }) });

  // 2) this month vs last month
  const cur = {}, last = {};
  monthTx(0).filter(x => x.type === 'expense').forEach(x => cur[x.envelopeId] = (cur[x.envelopeId] || 0) + x.amount);
  monthTx(1).filter(x => x.type === 'expense').forEach(x => last[x.envelopeId] = (last[x.envelopeId] || 0) + x.amount);
  const ids = [...new Set([...Object.keys(cur), ...Object.keys(last)])];
  if (ids.length === 0) chartEmpty('analyticsCompareChart');
  else mountChart('analyticsCompareChart', { type: 'bar', data: { labels: ids.map(nameOf), datasets: [
      { label: t('lastMonth'), data: ids.map(id => last[id] || 0), backgroundColor: '#A9B7B0' },
      { label: t('thisMonthF'), data: ids.map(id => cur[id] || 0), backgroundColor: '#2F6F5E' },
    ] }, options: Object.assign({}, base, { plugins: { legend: { labels: { color: ink } } }, scales: axes }) });

  // 3) 6-month trend
  const months = [], incArr = [], expArr = [];
  for (let i = 5; i >= 0; i--) {
    months.push(t('months')[monthStart(i).getMonth()]);
    incArr.push(monthIncome(i)); expArr.push(monthExpense(i));
  }
  if (![...incArr, ...expArr].some(v => v > 0)) chartEmpty('analyticsTrendChart');
  else mountChart('analyticsTrendChart', { type: 'line', data: { labels: months, datasets: [
      { label: t('income'), data: incArr, borderColor: '#3F8F5F', backgroundColor: 'rgba(63,143,95,.15)', fill: true, tension: .3 },
      { label: t('expenses'), data: expArr, borderColor: '#C4514A', backgroundColor: 'rgba(196,81,74,.12)', fill: true, tension: .3 },
    ] }, options: Object.assign({}, base, { plugins: { legend: { labels: { color: ink } } }, scales: axes }) });
}

/* ============================== QUICK SMART ADD ============================== */
// Rule-based text parser (fully offline, on-device — not a connected AI model).
// Understands Arabic + English amounts and keywords, and guesses category + type.
const CATEGORY_KEYWORDS = {
  env_food: ['اكل','أكل','مطعم','فطار','غدا','عشا','عشاء','فول','طعمية','كشري','بيتزا','برجر','burger','pizza','food','lunch','dinner','breakfast','مطبخ','ساندوتش','وجبة'],
  env_treats: ['حلويات','شوكولاتة','شوكولا','حلو','عصير','آيس كريم','ايس كريم','candy','chocolate','juice','icecream','ice cream','dessert','حلوى'],
  env_transport: ['مواصلات','تاكسي','أوبر','اوبر','ميكروباص','ميني باص','أتوبيس','اتوبيس','مترو','بنزين','تكسي','uber','taxi','bus','metro','fuel','gas','transport','مشوار'],
  env_selfcare: ['حلاق','صالون','عطر','كريم','شامبو','سيلف كير','self care','haircut','skincare','salon','perfume'],
  env_fun: ['سينما','فيلم','لعبة','game','games','cinema','movie','ترفيه','بلايستيشن','play station','ps5','ps4','netflix','نتفلكس'],
  env_books: ['كتاب','كتب','مذكرة','مذكرات','book','books','notebook'],
  env_lessons: ['درس','دروس','مجموعة','سنتر','مدرس','lesson','lessons','tutoring','tuition'],
  env_savings: ['توفير','ادخار','savings','save'],
};
function parseQuickAddText(text) {
  const raw = text.trim();
  const lower = raw.toLowerCase();
  // amount: first number found (supports Arabic-Indic digits too)
  const arabicDigits = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
  const normalized = raw.replace(/[٠-٩]/g, d => arabicDigits[d]);
  const amountMatch = normalized.match(/(\d+(\.\d+)?)/);
  const amount = amountMatch ? parseFloat(amountMatch[1]) : null;
  // type: income vs expense
  const incomeHints = ['استلمت','قبضت','اداني','ادتني','خدت','دخل','received','got','income','مصروفي','هدية','gift'];
  const isIncome = incomeHints.some(h => lower.includes(h));
  // category guess
  let bestCat = null;
  for (const [envId, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some(w => lower.includes(w.toLowerCase()))) { bestCat = envId; break; }
  }
  if (!bestCat) bestCat = 'env_personal';
  return { amount, envelopeId: bestCat, type: isIncome ? 'income' : 'expense', description: raw };
}
function renderQuickAdd() {
  const isAr = state.settings.language === 'ar';
  return `
    <div class="card">
      <p class="small-note" style="margin-bottom:10px;">${isAr
        ? 'اكتب اللي حصل بجملة عادية زي "اشتريت عصير بـ 25 جنيه" أو "استلمت 500 جنيه هدية"، والتطبيق هيحاول يفهمها ويقترح تسجيلها. (تحليل محلي على جهازك، مش AI متصل بالإنترنت.)'
        : 'Type what happened in plain language like "bought juice for 25" or "got 500 gift". The app will try to understand it locally on your device (no internet AI connection).'}</p>
      <div class="form-group"><textarea id="qaText" placeholder="${isAr?'مثال: اشتريت عصير بـ 25 جنيه':'e.g. bought juice for 25'}" style="min-height:70px;"></textarea></div>
      <button class="btn btn-primary" onclick="runQuickAddParse()">✨ ${isAr?'افهم واقترح':'Analyze'}</button>
    </div>
    <div id="qaResult"></div>
  `;
}
function runQuickAddParse() {
  const text = document.getElementById('qaText').value;
  if (!text.trim()) return;
  const p = parseQuickAddText(text);
  const isAr = state.settings.language === 'ar';
  if (!p.amount) {
    document.getElementById('qaResult').innerHTML = `<div class="alert-card warn"><div>⚠️</div><div class="t">${isAr?'ملقتش مبلغ في الجملة، اكتب الرقم بوضوح.':"Couldn't find an amount — please include a clear number."}</div></div>`;
    return;
  }
  const env = getEnvelope(p.envelopeId);
  document.getElementById('qaResult').innerHTML = `
    <div class="card">
      <div class="list-row"><div class="mid t1">${isAr?'النوع':'Type'}</div><div class="amt neu">${p.type==='income'?t('incomeF'):t('expenseF')}</div></div>
      <div class="list-row"><div class="mid t1">${t('amount')}</div><div class="amt neu">${fmt(p.amount)} ${state.settings.currency}</div></div>
      ${p.type==='expense' ? `<div class="list-row"><div class="mid t1">${t('category')}</div><div class="amt neu">${env.icon} ${envLabel(env)}</div></div>` : ''}
      <div class="list-row"><div class="mid t1">${t('date')}</div><div class="amt neu">${todayStr()}</div></div>
    </div>
    <p class="small-note">${isAr?'مش الفئة الصح؟ عدّلها هنا قبل الحفظ:':'Wrong category? Adjust it before saving:'}</p>
    ${p.type==='expense' ? `<div class="form-group"><div class="chip-select" id="qaCatPicker">${state.envelopes.map(e=>`<div class="chip ${e.id===p.envelopeId?'selected':''}" data-env="${e.id}" onclick="selectChip(this)">${e.icon} ${envLabel(e)}</div>`).join('')}</div></div>` : ''}
    <button class="btn btn-primary" onclick='confirmQuickAdd(${JSON.stringify(p)})'>${isAr?'تأكيد وحفظ':'Confirm & save'}</button>
  `;
}
function confirmQuickAdd(p) {
  const chosenCat = document.querySelector('#qaCatPicker .chip.selected')?.dataset.env || p.envelopeId;
  if (p.type === 'income') {
    state.transactions.push({ id: uid(), type: 'income', amount: p.amount, source: 'other', date: todayStr(), walletId: state.wallets[0]?.id, note: p.description, allocations: [{ envelopeId: 'env_personal', amount: p.amount }], createdAt: Date.now() });
  } else {
    state.transactions.push({ id: uid(), type: 'expense', amount: p.amount, envelopeId: chosenCat, description: p.description, date: todayStr(), walletId: state.wallets[0]?.id, createdAt: Date.now() });
  }
  saveState(); toast(t('savedSuccess')); nav('dashboard');
}

/* ============================== CUSTOM QUICK ADD BUTTONS ============================== */
function renderManageQuickAdd() {
  const qabs = state.quickAddButtons || [];
  const isAr = state.settings.language === 'ar';
  return `
    <div class="fab-row"><button class="btn btn-primary" onclick="openAddQuickAddSheet()">➕ ${t('addQuickAdd')}</button></div>
    ${qabs.length === 0 ? emptyState('⚡', t('noQuickAdd'), t('noQuickAddSub')) :
      `<div class="card">${qabs.map(q => {
        const env = getEnvelope(q.envelopeId);
        return `<div class="list-row">
          <div class="ico-badge">${q.icon}</div>
          <div class="mid"><div class="t1">${q.label}</div><div class="t2">${env ? env.icon+' '+envLabel(env) : ''} · ${fmt(q.amount)} ${state.settings.currency}</div></div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-outline btn-sm" onclick="openEditQuickAddSheet('${q.id}')">✏️</button>
            <button class="btn btn-danger btn-sm" onclick="deleteQuickAdd('${q.id}')">🗑️</button>
          </div>
        </div>`;
      }).join('')}</div>`}
    <div class="section-head"><h2>${isAr?'معاينة':'Preview'}</h2></div>
    ${qabs.length > 0 ? `<div class="quick-add-grid">${qabs.map(q => `
      <button class="quick-add-btn" onclick="executeQuickAdd('${q.id}')">
        <span class="qa-icon">${q.icon}</span>
        <span class="qa-label">${q.label}</span>
        <span class="qa-amount">${fmt(q.amount)} ${state.settings.currency}</span>
      </button>`).join('')}</div>` : `<p class="small-note">${isAr?'الأزرار هتظهر هنا':'Buttons will appear here'}</p>`}
  `;
}
function openAddQuickAddSheet() {
  const icons = ['🚌','🥤','🍔','📚','📝','🎮','🍫','🧴','☕','🛒','💊','🎬','✈️','🏋️','🎵','📱'];
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addQuickAdd')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('quickAddLabel')}</label><input type="text" id="qaLabel" placeholder="${state.settings.language==='ar'?'مثال: مواصلات 8':'e.g. Bus 8'}"></div>
    <div class="form-group"><label>${t('quickAddAmount')}</label><input type="number" id="qaAmount" placeholder="0"></div>
    <div class="form-group"><label>${t('quickAddCategory')}</label>
      <div class="chip-select">${state.envelopes.map((e,i)=>`<div class="chip ${i===0?'selected':''}" data-env="${e.id}" onclick="selectChip(this)">${e.icon} ${envLabel(e)}</div>`).join('')}</div>
    </div>
    <div class="form-group"><label>${t('chooseIcon')}</label>
      <div class="chip-select" id="qaIconPicker">${icons.map((i,idx)=>`<div class="chip ${idx===0?'selected':''}" data-ic="${i}" onclick="pickIcon(this)">${i}</div>`).join('')}</div>
    </div>
    <button class="btn btn-primary" onclick="saveQuickAdd()">${t('save')}</button>
  `);
}
function saveQuickAdd() {
  const label = document.getElementById('qaLabel').value.trim();
  const amount = parseFloat(document.getElementById('qaAmount').value) || 0;
  const envelopeId = document.querySelector('#sheet .chip.selected')?.dataset.env;
  const icon = document.querySelector('#qaIconPicker .chip.selected')?.dataset.ic || '⚡';
  if (!label) { toast(state.settings.language==='ar'?'اكتب اسم الزر':'Enter a label'); return; }
  if (amount <= 0) { toast(state.settings.language==='ar'?'اكتب مبلغ صحيح':'Enter a valid amount'); return; }
  state.quickAddButtons = state.quickAddButtons || [];
  state.quickAddButtons.push({ id: uid(), icon, label, envelopeId, amount });
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}
function openEditQuickAddSheet(id) {
  const q = (state.quickAddButtons || []).find(x => x.id === id);
  if (!q) return;
  const icons = ['🚌','🥤','🍔','📚','📝','🎮','🍫','🧴','☕','🛒','💊','🎬','✈️','🏋️','🎵','📱'];
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('editQuickAdd')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('quickAddLabel')}</label><input type="text" id="qaLabel" value="${q.label}"></div>
    <div class="form-group"><label>${t('quickAddAmount')}</label><input type="number" id="qaAmount" value="${q.amount}"></div>
    <div class="form-group"><label>${t('quickAddCategory')}</label>
      <div class="chip-select">${state.envelopes.map(e=>`<div class="chip ${e.id===q.envelopeId?'selected':''}" data-env="${e.id}" onclick="selectChip(this)">${e.icon} ${envLabel(e)}</div>`).join('')}</div>
    </div>
    <div class="form-group"><label>${t('chooseIcon')}</label>
      <div class="chip-select" id="qaIconPicker">${icons.map(i=>`<div class="chip ${i===q.icon?'selected':''}" data-ic="${i}" onclick="pickIcon(this)">${i}</div>`).join('')}</div>
    </div>
    <button class="btn btn-primary" onclick="updateQuickAdd('${id}')">${t('save')}</button>
  `);
}
function updateQuickAdd(id) {
  const q = (state.quickAddButtons || []).find(x => x.id === id);
  if (!q) return;
  q.label = document.getElementById('qaLabel').value.trim() || q.label;
  q.amount = parseFloat(document.getElementById('qaAmount').value) || q.amount;
  q.envelopeId = document.querySelector('#sheet .chip.selected')?.dataset.env || q.envelopeId;
  q.icon = document.querySelector('#qaIconPicker .chip.selected')?.dataset.ic || q.icon;
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}
function deleteQuickAdd(id) {
  state.quickAddButtons = (state.quickAddButtons || []).filter(x => x.id !== id);
  saveState(); toast(t('deletedSuccess')); render();
}
function executeQuickAdd(id) {
  const q = (state.quickAddButtons || []).find(x => x.id === id);
  if (!q) return;
  if (!confirm(`${q.icon} ${q.label} — ${fmt(q.amount)} ${state.settings.currency}\n${t('confirmQuickAdd')}`)) return;
  const walletId = state.wallets[0]?.id;
  cashResolve(q.amount, walletId, (paid, change) => {
    const cashFields = paid ? { cashPaid: paid, cashChange: change } : {};
    if (paid) applyCashMovement(paid, change, +1);
    state.transactions.push(Object.assign({ id: uid(), type: 'expense', amount: q.amount, envelopeId: q.envelopeId, description: q.label, date: todayStr(), walletId, createdAt: Date.now() }, cashFields));
    saveState(); closeSheet(); toast(t('savedSuccess')); render();
  });
}

/* ============================== MONTHLY REVIEW ============================== */
function renderMonthlyReview() {
  const isAr = state.settings.language === 'ar';
  const inc = monthIncome(0), exp = monthExpense(0), sav = monthSaving(0);
  const incLast = monthIncome(1), expLast = monthExpense(1);
  const byCat = {};
  monthTx(0).filter(tx => tx.type === 'expense').forEach(tx => { byCat[tx.envelopeId] = (byCat[tx.envelopeId] || 0) + tx.amount; });
  const sorted = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const topCat = sorted[0];
  const comparison = expLast > 0 ? Math.round(((expLast - exp) / expLast) * 100) : 0;
  const monthIdx = new Date().getMonth();
  const monthName = t('months')[monthIdx];
  const year = new Date().getFullYear();

  let compText, compColor;
  if (expLast === 0 && exp === 0) { compText = t('reviewNoChange'); compColor = 'var(--accent)'; }
  else if (comparison > 0) { compText = `${t('reviewComparison')} ${comparison}% 🟢`; compColor = 'var(--good)'; }
  else if (comparison === 0) { compText = t('reviewNoChange'); compColor = 'var(--accent)'; }
  else { compText = `${isAr?'صرفك ا زيادة عن الشهر اللي فات':'Your spending increased'} ${Math.abs(comparison)}% 🔴`; compColor = 'var(--bad)'; }

  return `
    <div class="hero" style="background:linear-gradient(155deg, var(--primary) 0%, var(--primary-2) 100%);">
      <div class="label">📊 ${t('monthlyReview')}</div>
      <div class="amount" style="font-size:28px;">${monthName} ${year}</div>
    </div>

    <div class="card">
      <div class="list-row"><div class="ico-badge">💰</div><div class="mid t1">${t('reviewIncome')}</div><div class="amt pos">+${fmt(inc)}</div></div>
      <div class="list-row"><div class="ico-badge">💸</div><div class="mid t1">${t('reviewExpense')}</div><div class="amt neg">-${fmt(exp)}</div></div>
      <div class="list-row"><div class="ico-badge">💵</div><div class="mid t1">${t('reviewSaved')}</div><div class="amt ${sav>=0?'pos':'neg'}">${fmt(sav)}</div></div>
      <div class="list-row"><div class="ico-badge">📊</div><div class="mid t1">${t('netChange')}</div><div class="amt ${inc-exp>=0?'pos':'neg'}">${signedMoney(inc-exp)}</div></div>
      ${topCat ? `<div class="list-row"><div class="ico-badge">${getEnvelope(topCat[0])?.icon||'📦'}</div><div class="mid t1">${t('reviewTopCategory')}</div><div class="amt neu">${envLabel(getEnvelope(topCat[0])||{})}</div></div>` : ''}
    </div>

    <div class="card" style="background:linear-gradient(155deg, ${compColor}15, ${compColor}08); border-color:${compColor}40;">
      <div style="text-align:center; padding:8px 0;">
        <div style="font-size:13px; font-weight:700; color:${compColor};">${compText}</div>
      </div>
    </div>

    ${Object.keys(byCat).length > 0 ? `
    <div class="section-head"><h2>${isAr?'تفاصيل الصرف':'Spending breakdown'}</h2></div>
    <div class="card">${Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([envId, val]) => {
      const e = getEnvelope(envId);
      const pct = exp > 0 ? Math.round((val/exp)*100) : 0;
      return `<div class="list-row">
        <div class="ico-badge">${e?.icon||'📦'}</div>
        <div class="mid"><div class="t1">${envLabel(e||{name:envId})}</div>
          <div class="progress-track" style="margin-top:4px;"><div class="progress-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="amt neu">${fmt(val)} (${pct}%)</div>
      </div>`;
    }).join('')}</div>` : ''}

    <button class="btn btn-primary" onclick="startNewMonth()" style="margin-top:10px;">🔄 ${t('startNewMonth')}</button>
  `;
}
function startNewMonth() {
  if (!confirm(state.settings.language==='ar' ? 'هتبدأ شهر جديد — ملخص الشهر الحالي هيفضل متسجل في العمليات.' : 'Start a new month — the current month summary will remain in your history.')) return;
  toast(state.settings.language==='ar' ? 'بدأ شهر جديد! 🎉' : 'New month started! 🎉');
  nav('dashboard');
}

/* ============================== OWED TO YOU ============================== */
function renderOwedToYou() {
  const isAr = state.settings.language === 'ar';
  const items = (state.owedToYou || []).sort((a,b) => (b.returned ? 1 : 0) - (a.returned ? 1 : 0) || new Date(b.date) - new Date(a.date));
  const totalOwed = owedToYouTotal();
  return `
    <div class="hero">
      <div class="label">🤝 ${t('owedToYou')}</div>
      <div class="amount">${money(totalOwed)}</div>
    </div>
    <div class="fab-row"><button class="btn btn-primary" onclick="openAddOwedSheet()">➕ ${t('addOwed')}</button></div>
    ${items.length === 0 ? emptyState('🤝', t('noOwed'), t('addFirst')) :
      `<div class="card">${items.map(o => `
        <div class="list-row" style="${o.returned?'opacity:.5;':''}">
          <div class="ico-badge">🤝</div>
          <div class="mid"><div class="t1">${o.person}</div><div class="t2">${o.date}${o.note ? ' · '+o.note : ''}</div></div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="amt ${o.returned?'neu':'pos'}">${money(o.amount)}</div>
            ${!o.returned ? `<button class="btn btn-outline btn-sm" onclick="markOwedReturned('${o.id}')">✅</button>` : `<span class="badge paid">${isAr?'رجع':'Done'}</span>`}
          </div>
        </div>`).join('')}</div>`}
  `;
}
function openAddOwedSheet() {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addOwed')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('owedPerson')}</label><input type="text" id="owPerson" placeholder="${state.settings.language==='ar'?'اسم الشخص':'Person name'}"></div>
    <div class="form-group"><label>${t('owedAmount')}</label><input type="number" id="owAmount" placeholder="0"></div>
    <div class="form-group"><label>${t('owedDate')}</label><input type="date" id="owDate" value="${todayStr()}"></div>
    <div class="form-group"><label>${t('owedNote')}</label><input type="text" id="owNote" placeholder="${state.settings.language==='ar'?'اختياري':'Optional'}"></div>
    <button class="btn btn-primary" onclick="saveOwed()">${t('save')}</button>
  `);
}
function saveOwed() {
  const person = document.getElementById('owPerson').value.trim();
  const amount = parseFloat(document.getElementById('owAmount').value) || 0;
  const date = document.getElementById('owDate').value || todayStr();
  const note = document.getElementById('owNote').value.trim();
  if (!person) { toast(state.settings.language==='ar'?'اكتب اسم الشخص':'Enter a name'); return; }
  if (amount <= 0) { toast(state.settings.language==='ar'?'اكتب مبلغ صحيح':'Enter a valid amount'); return; }
  state.owedToYou = state.owedToYou || [];
  state.owedToYou.push({ id: uid(), person, amount, date, note, returned: false });
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}
function markOwedReturned(id) {
  const o = (state.owedToYou || []).find(x => x.id === id);
  if (o) { o.returned = true; saveState(); toast(t('savedSuccess')); render(); }
}

/* ============================== UPCOMING MONEY ============================== */
function renderUpcoming() {
  const isAr = state.settings.language === 'ar';
  const items = (state.upcoming || []).sort((a,b) => new Date(a.date) - new Date(b.date));
  const total = upcomingTotal();
  return `
    <div class="hero">
      <div class="label">📅 ${t('upcomingMoney')}</div>
      <div class="amount">${money(total)}</div>
    </div>
    <div class="fab-row"><button class="btn btn-primary" onclick="openAddUpcomingSheet()">➕ ${t('addUpcoming')}</button></div>
    ${items.length === 0 ? emptyState('📅', t('noUpcoming'), t('addFirst')) :
      `<div class="card">${items.map(u => `
        <div class="list-row">
          <div class="ico-badge">📅</div>
          <div class="mid"><div class="t1">${u.name}</div><div class="t2">${u.date}${u.note ? ' · '+u.note : ''}</div></div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="amt pos">${money(u.amount)}</div>
            <button class="btn btn-outline btn-sm" onclick="deleteUpcoming('${u.id}')">🗑️</button>
          </div>
        </div>`).join('')}</div>`}
  `;
}
function openAddUpcomingSheet() {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addUpcoming')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('upcomingName')}</label><input type="text" id="upName" placeholder="${state.settings.language==='ar'?'مثال: مصروف الدرس':'e.g. Lesson fee'}"></div>
    <div class="form-group"><label>${t('upcomingAmount')}</label><input type="number" id="upAmount" placeholder="0"></div>
    <div class="form-group"><label>${t('upcomingDate')}</label><input type="date" id="upDate" value="${todayStr()}"></div>
    <div class="form-group"><label>${t('upcomingNote')}</label><input type="text" id="upNote" placeholder="${state.settings.language==='ar'?'اختياري':'Optional'}"></div>
    <button class="btn btn-primary" onclick="saveUpcoming()">${t('save')}</button>
  `);
}
function saveUpcoming() {
  const name = document.getElementById('upName').value.trim();
  const amount = parseFloat(document.getElementById('upAmount').value) || 0;
  const date = document.getElementById('upDate').value || todayStr();
  const note = document.getElementById('upNote').value.trim();
  if (!name) { toast(state.settings.language==='ar'?'اكتب اسم المصروف':'Enter a name'); return; }
  if (amount <= 0) { toast(state.settings.language==='ar'?'اكتب مبلغ صحيح':'Enter a valid amount'); return; }
  state.upcoming = state.upcoming || [];
  state.upcoming.push({ id: uid(), name, amount, date, note });
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}
function deleteUpcoming(id) {
  state.upcoming = (state.upcoming || []).filter(x => x.id !== id);
  saveState(); toast(t('deletedSuccess')); render();
}

/* ============================== NOTIFICATIONS / REMINDERS ============================== */
// Best-effort local reminders using the browser Notification API.
// NOTE: because this is a plain offline web page (no installed Service Worker / PWA),
// these only fire while the app tab is open on this device — not real background push.
// If you convert the app to a PWA/APK later, this can be upgraded to true background notifications.
function notificationsSupported() { return 'Notification' in window; }
function notificationsEnabled() { return notificationsSupported() && Notification.permission === 'granted'; }
async function requestNotificationPermission() {
  if (!notificationsSupported()) { toast(state.settings.language==='ar'?'المتصفح ده مش بيدعم التنبيهات':'This browser does not support notifications'); return; }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') { toast(t('savedSuccess')); fireDueReminders(true); }
  render();
}
let __lastReminderFireDay = null;
function fireDueReminders(force) {
  if (!notificationsEnabled()) return;
  const today = todayStr();
  if (!force && __lastReminderFireDay === today) return;
  __lastReminderFireDay = today;
  const isAr = state.settings.language === 'ar';
  const alerts = computeAlerts().filter(a => a.level === 'danger' || a.level === 'warn');
  alerts.slice(0, 3).forEach(a => {
    try { new Notification(t('appName'), { body: a.text, icon: '' }); } catch (e) {}
  });
  if (alerts.length === 0 && force) {
    try { new Notification(t('appName'), { body: isAr ? 'كل حاجة تمام، هنفكرك لو في حاجة مهمة 👍' : "All good — we'll remind you if something needs attention 👍" }); } catch (e) {}
  }
}
function scheduleReminderCheck() {
  fireDueReminders(false);
  setInterval(() => fireDueReminders(false), 6 * 60 * 60 * 1000); // re-check every 6h while app is open
}

/* ============================== GOOGLE ACCOUNT LINKING ============================== */
function googleLinkRowHtml() {
  if (!window.FB || !window.FB.getProviderIds) return '';
  const ar = isArabic();
  const linked = window.FB.getProviderIds().includes('google.com');
  if (linked) {
    return `<div class="settings-row"><div><div class="st">🔗 ${ar ? 'حساب Google' : 'Google account'}</div><div class="ss">${ar ? 'مربوط ✅ — تقدر تدخل بيه من أي جهاز' : 'Linked ✅ — you can sign in with it on any device'}</div></div></div>`;
  }
  return `<div class="settings-row" style="cursor:pointer;" onclick="linkGoogleAccount()"><div><div class="st">🔗 ${ar ? 'ربط حساب Google' : 'Link Google account'}</div><div class="ss">${ar ? 'اربط حسابك بجوجل عشان تدخل بضغطة واحدة' : 'Link it to sign in with one tap'}</div></div><div class="amt neu">›</div></div>`;
}
async function linkGoogleAccount() {
  if (window.__authBusy) return;
  window.__authBusy = true;
  try {
    await window.FB.linkGoogle();
    window.__userEmail = (window.FB.auth.currentUser && window.FB.auth.currentUser.email) || window.__userEmail;
    toast(isArabic() ? 'اتربط حساب Google ✅' : 'Google account linked ✅');
    render();
  } catch (e) {
    toast(authErrorMessage(e));
  } finally {
    window.__authBusy = false;
  }
}

/* ============================== CASH MANAGER (الفكة) ============================== */
const DEFAULT_DENOMS = [200, 100, 50, 20, 10, 5, 1, 0.5, 0.25];
const QU = x => Math.round(x * 4); // work in quarter-pound units so floats never bite
function isArabic() { return state.settings.language === 'ar'; }
function denLabel(d) {
  const ar = isArabic();
  if (d >= 1) return ar ? `${d} جنيه` : `${d} EGP`;
  return ar ? `${d * 100} قرش` : `${d * 100} pt`;
}
function denSummary(counts) {
  const parts = Object.keys(counts || {}).map(Number).filter(d => counts[d] > 0).sort((a, b) => b - a)
    .map(d => `${counts[d]} × ${denLabel(d)}`);
  return parts.length ? parts.join(' + ') : '—';
}
function sumCounts(counts) { return Object.keys(counts || {}).reduce((a, d) => a + Number(d) * (counts[d] || 0), 0); }
function cashList() { if (!Array.isArray(state.cashDenominations)) state.cashDenominations = []; return state.cashDenominations; }
function denCount(d) { const r = cashList().find(x => x.denomination === d); return r ? (r.count || 0) : 0; }
function setDenCount(d, n) {
  n = Math.max(0, Math.round(n));
  const r = cashList().find(x => x.denomination === d);
  if (r) r.count = n; else cashList().push({ denomination: d, count: n });
}
function cashTotal() { return cashList().reduce((a, r) => a + r.denomination * (r.count || 0), 0); }
function cashAdjust(d, delta) { setDenCount(d, denCount(d) + delta); saveState(); render(); }
function removeDenom(d) { state.cashDenominations = cashList().filter(r => r.denomination !== d); saveState(); render(); }
function seedDenoms() { DEFAULT_DENOMS.forEach(d => { if (!cashList().some(r => r.denomination === d)) cashList().push({ denomination: d, count: 0 }); }); saveState(); render(); }
function isCashWalletId(id) { const w = getWallet(id); return !!w && (w.key === 'cash' || w.id === 'wal_cash'); }
function greedyChange(changeAmt) {
  let u = QU(changeAmt); const out = {};
  for (const d of DEFAULT_DENOMS) { const du = QU(d); const n = Math.floor(u / du); if (n > 0) { out[d] = n; u -= n * du; } }
  return out;
}
// dir = +1 when an expense is recorded (paid bills leave, change comes in); -1 to undo it.
function applyCashMovement(paid, change, dir) {
  Object.keys(paid || {}).forEach(k => { const d = Number(k); setDenCount(d, denCount(d) - dir * paid[k]); });
  Object.keys(change || {}).forEach(k => { const d = Number(k); setDenCount(d, denCount(d) + dir * change[k]); });
}

function renderCashManager() {
  const ar = isArabic(), cur = state.settings.currency;
  const rows = cashList().slice().sort((a, b) => b.denomination - a.denomination);
  return `
    <div class="hero" style="margin-bottom:14px;">
      <div class="label">${t('cashOnHand')}</div>
      <div class="amount">${fmt(cashTotal())} ${cur}</div>
      <div class="small-note" style="color:#F5FBF8; opacity:.8;">${ar ? 'كل ما تصرف كاش وتسجّل اللي دفعته والباقي، الفئات هنا بتتحدّث لوحدها.' : 'When you log a cash expense with what you paid and the change, these counts update automatically.'}</div>
    </div>
    <div class="card">
      ${rows.length === 0 ? emptyState('💵', t('noDenominations'), '') : rows.map(r => `
        <div class="list-row">
          <div class="ico-badge">${r.denomination >= 1 ? '💵' : '🪙'}</div>
          <div class="mid"><div class="t1">${denLabel(r.denomination)}</div><div class="t2">${t('total')}: ${fmt(r.denomination * (r.count || 0))} ${cur}</div></div>
          ${(r.count || 0) === 0 ? `<button class="step-btn" style="margin-inline-end:6px;" onclick="removeDenom(${r.denomination})" title="delete">🗑</button>` : ''}
          <div class="stepper"><button class="step-btn" onclick="cashAdjust(${r.denomination},-1)">−</button><span class="step-val">${r.count || 0}</span><button class="step-btn" onclick="cashAdjust(${r.denomination},1)">+</button></div>
        </div>`).join('')}
    </div>
    <label class="card" style="display:flex; align-items:center; justify-content:space-between; gap:10px; cursor:pointer;">
      <span><div class="t1" style="font-weight:800; font-size:13.5px;">⚡ ${ar ? 'خصم تلقائي من الفكة' : 'Auto-deduct from cash'}</div>
      <div class="small-note">${ar ? 'لما تصرف كاش من غير ما تختار الفئات، يخصم بأحسن طريقة دفع ويضبط الباقي لوحده. لو مقفول بيسألك تدفع إزاي.' : 'When you spend cash without picking bills, it pays the best way and sets the change. If off, it asks you how you paid.'}</div></span>
      <input type="checkbox" ${state.settings.cashAutoDeduct ? 'checked' : ''} onchange="state.settings.cashAutoDeduct=this.checked; saveState(); toast(this.checked ? '${ar ? 'الخصم التلقائي شغال' : 'Auto-deduct on'}' : '${ar ? 'هيسألك كل مرة' : 'Will ask each time'}')">
    </label>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="openAddDenomSheet()">➕ ${t('addDenomination')}</button>
      ${rows.length === 0 ? `<button class="btn btn-accent" onclick="seedDenoms()">${ar ? 'الفئات الافتراضية' : 'Default set'}</button>` : ''}
    </div>

    <div class="section-head"><h2>🧠 ${t('smartPay')}</h2></div>
    <div class="card">
      <div class="form-group"><label>${ar ? 'المبلغ اللي هتدفعه' : 'Amount to pay'}</label>
        <input type="number" inputmode="decimal" id="spAmount" placeholder="0" value="${escAttr(window.__spAmt || '')}" oninput="onSmartPayInput(this.value)"></div>
      <div id="smartPayResults">${smartPayHtml()}</div>
    </div>
  `;
}
function openAddDenomSheet() {
  const ar = isArabic();
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${t('addDenomination')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('denomination')} (${state.settings.currency})</label><input type="number" inputmode="decimal" id="denValue" placeholder="${ar ? 'مثلاً 10' : 'e.g. 10'}"></div>
    <div class="form-group"><label>${t('count')}</label><input type="number" inputmode="numeric" id="denCount" value="0"></div>
    <button class="btn btn-primary" onclick="saveDenomination()">${t('save')}</button>
  `);
}
function saveDenomination() {
  const d = parseFloat(document.getElementById('denValue').value);
  const n = parseInt(document.getElementById('denCount').value, 10) || 0;
  if (!d || d <= 0) { toast(isArabic() ? 'اكتب فئة صحيحة' : 'Enter a valid denomination'); return; }
  if (Math.abs(d * 4 - Math.round(d * 4)) > 1e-9) { toast(isArabic() ? 'الفئة لازم تكون من مضاعفات 25 قرش' : 'Denomination must be a multiple of 0.25'); return; }
  setDenCount(d, denCount(d) + n);
  saveState(); closeSheet(); render();
}

/* ---- Smart Pay: pick bills from what you hold so change is minimal ---- */
function computePayOptions(amount) {
  const hand = cashList().filter(r => (r.count || 0) > 0 && r.denomination > 0)
    .map(r => ({ d: r.denomination, u: QU(r.denomination), c: Math.floor(r.count) }))
    .filter(x => x.u > 0).sort((a, b) => b.u - a.u);
  const aU = Math.ceil(amount * 4 - 1e-9);
  if (!hand.length || aU <= 0 || aU > 40000) return { options: [], short: false };
  const handTotal = hand.reduce((a, x) => a + x.u * x.c, 0);
  if (handTotal < aU) return { options: [], short: true };
  const limit = Math.min(aU + hand[0].u, handTotal);
  const dp = new Array(limit + 1).fill(null);
  dp[0] = { p: 0, cnt: hand.map(() => 0) };
  hand.forEach((h, hi) => {
    const copies = Math.min(h.c, Math.ceil(limit / h.u));
    for (let k = 0; k < copies; k++) {
      for (let tot = limit; tot >= h.u; tot--) {
        const prev = dp[tot - h.u];
        if (!prev) continue;
        if (!dp[tot] || prev.p + 1 < dp[tot].p) { const cnt = prev.cnt.slice(); cnt[hi]++; dp[tot] = { p: prev.p + 1, cnt }; }
      }
    }
  });
  const cands = [];
  for (let tot = aU; tot <= limit; tot++) {
    if (!dp[tot]) continue;
    const counts = {};
    dp[tot].cnt.forEach((n, i) => { if (n > 0) counts[hand[i].d] = n; });
    const change = tot / 4 - amount;
    const changeCounts = change > 0.001 ? greedyChange(change) : {};
    const changePieces = Object.keys(changeCounts).reduce((a, k) => a + changeCounts[k], 0);
    cands.push({ counts, total: tot / 4, change, changeCounts, pieces: dp[tot].p, score: dp[tot].p + changePieces });
  }
  // fewest bills/coins changing hands (what you give + what comes back), then smallest overpay
  cands.sort((x, y) => x.score - y.score || x.total - y.total);
  const options = cands.slice(0, 3);
  return { options, short: false };
}
function onSmartPayInput(v) {
  window.__spAmt = v;
  const el = document.getElementById('smartPayResults');
  if (el) el.innerHTML = smartPayHtml();
}
function smartPayHtml() {
  const ar = isArabic(), cur = state.settings.currency;
  const amount = parseFloat(window.__spAmt);
  if (!amount || amount <= 0) return `<div class="small-note">${ar ? 'اكتب المبلغ وهقولك تدفع بإيه من الفئات اللي معاك.' : 'Type an amount and I will suggest what to hand over.'}</div>`;
  if (cashList().every(r => !r.count)) return `<div class="small-note">${t('noDenominations')}</div>`;
  const { options, short } = computePayOptions(amount);
  window.__spOptions = options;
  if (short) return `<div class="alert-card danger"><div class="t">${ar ? 'الكاش اللي معاك أقل من المبلغ ده.' : "You don't have enough cash for this amount."}</div></div>`;
  if (!options.length) return `<div class="small-note">${ar ? 'مفيش طريقة دفع متاحة بالفئات الحالية.' : 'No payment combination with current denominations.'}</div>`;
  return `<div class="small-note" style="margin-bottom:8px;">${t('payWithOptions')}</div>` + options.map((o, i) => `
    <div class="card" style="margin-bottom:8px; ${i === 0 ? 'border-color:var(--primary-2);' : ''}">
      ${i === 0 ? `<span class="badge paid">${t('bestCombo')}</span>` : ''}
      <div class="t1" style="font-size:13.5px; font-weight:800; margin:6px 0 2px;">${denSummary(o.counts)}</div>
      <div class="small-note">${ar ? 'إجمالي' : 'Total'}: ${fmt(o.total)} ${cur} · ${t('change')}: <b>${o.change > 0.001 ? fmt(o.change) + ' ' + cur : (ar ? 'مفيش' : 'none')}</b>${o.change > 0.001 ? ` (${denSummary(o.changeCounts)})` : ''}</div>
      <button class="btn btn-outline btn-sm" style="margin-top:8px;" onclick="useSmartPay(${i})">${ar ? 'سجّل الصرف بالطريقة دي' : 'Log expense this way'}</button>
    </div>`).join('');
}
function useSmartPay(i) {
  const o = (window.__spOptions || [])[i]; if (!o) return;
  openAddExpenseSheet(null, { amount: parseFloat(window.__spAmt), paid: o.counts });
}

/* ---- Cash section inside the "add expense" sheet ---- */
function cashWalletChanged() {
  const sel = document.getElementById('exWallet'), sec = document.getElementById('cashSection');
  if (!sel || !sec) return;
  if (!isCashWalletId(sel.value)) { window.__cashPaid = {}; window.__cashChange = {}; sec.innerHTML = ''; return; }
  cashSectionRefresh();
}
function cashSectionRefresh() {
  const sel = document.getElementById('exWallet'), sec = document.getElementById('cashSection');
  if (!sel || !sec || !isCashWalletId(sel.value)) return;
  // drop paid counts we no longer hold
  Object.keys(window.__cashPaid || {}).forEach(k => { const mx = denCount(Number(k)); if (window.__cashPaid[k] > mx) window.__cashPaid[k] = mx; if (window.__cashPaid[k] <= 0) delete window.__cashPaid[k]; });
  const amount = parseFloat((document.getElementById('exAmount') || {}).value) || 0;
  const paidTotal = sumCounts(window.__cashPaid);
  if (!window.__cashChangeManual) window.__cashChange = paidTotal - amount > 0.13 ? greedyChange(paidTotal - amount) : {};
  sec.innerHTML = cashSectionHtml(amount, paidTotal);
}
function cashSectionHtml(amount, paidTotal) {
  const ar = isArabic(), cur = state.settings.currency;
  const held = cashList().filter(r => (r.count || 0) > 0).sort((a, b) => b.denomination - a.denomination);
  if (!held.length) {
    return `<div class="cash-box"><div class="small-note">💵 ${ar ? 'سجّل الفئات اللي معاك من "إدارة الفكة" (في قائمة المزيد) عشان تتابع اللي بتدفعه والباقي.' : 'Add your bills in "Cash Manager" (More menu) to track what you pay and the change.'}</div></div>`;
  }
  const expected = paidTotal - amount;
  const stepper = (d, count, fnAdj, max) => `
    <div class="den-row"><div class="den-name">${denLabel(d)}</div>
      <div class="stepper"><button type="button" class="step-btn" onclick="${fnAdj}(${d},-1)">−</button><span class="step-val">${count}</span><button type="button" class="step-btn" onclick="${fnAdj}(${d},1)" ${count >= max ? 'disabled' : ''}>+</button></div></div>`;
  let html = `<div class="cash-box">
    <div class="cash-title">💵 ${ar ? 'دفعت بإيه؟' : 'What did you pay with?'} <span class="small-note">(${ar ? 'اختياري' : 'optional'})</span></div>
    ${amount > 0 ? `<button type="button" class="btn btn-outline btn-sm" style="margin-bottom:8px;" onclick="cashSuggestPay()">🧠 ${ar ? 'اقترح عليّ أدفع بإيه' : 'Suggest what to pay with'}</button>` : ''}
    ${held.map(r => stepper(r.denomination, (window.__cashPaid || {})[r.denomination] || 0, 'cashPaidAdj', r.count)).join('')}`;
  if (paidTotal > 0) {
    html += `<div class="cash-sum">${ar ? 'اللي دفعته' : 'Paid'}: <b>${fmt(paidTotal)} ${cur}</b>`;
    if (amount > 0) html += ` · ${ar ? 'المبلغ' : 'Amount'}: <b>${fmt(amount)}</b>`;
    html += `</div>`;
    if (amount > 0 && expected < -0.13) {
      html += `<div class="split-total bad">${ar ? 'اللي دفعته أقل من المبلغ' : 'What you paid is less than the amount'}</div>`;
    } else if (amount > 0 && expected > 0.13) {
      const got = sumCounts(window.__cashChange), ok = Math.abs(got - expected) <= 0.13;
      const shown = DEFAULT_DENOMS.filter(d => d <= expected + 0.001 || (window.__cashChange || {})[d]);
      html += `<div class="cash-title" style="margin-top:12px;">↩️ ${ar ? 'الباقي اللي رجعلك' : 'Change you received'}: ${fmt(expected)} ${cur}</div>
        ${shown.map(d => stepper(d, (window.__cashChange || {})[d] || 0, 'cashChangeAdj', 999)).join('')}
        <div class="split-total ${ok ? 'ok' : 'bad'}">${ok ? (ar ? 'الباقي مظبوط ✔' : 'Change matches ✔') : (ar ? `مجموع الباقي ${fmt(got)} — المفروض ${fmt(expected)}` : `Change total ${fmt(got)} — expected ${fmt(expected)}`)}</div>
        <button type="button" class="btn btn-outline btn-sm" style="margin-top:8px;" onclick="cashChangeAuto()">${ar ? 'اقتراح تلقائي' : 'Auto-suggest'}</button>`;
    } else if (amount > 0) {
      html += `<div class="split-total ok">${ar ? 'دفعت بالظبط — مفيش باقي ✔' : 'Exact payment — no change ✔'}</div>`;
    }
  }
  return html + `</div>`;
}
function cashPaidAdj(d, delta) {
  const cur = (window.__cashPaid || {})[d] || 0;
  const n = Math.min(Math.max(0, cur + delta), denCount(d));
  if (n > 0) window.__cashPaid[d] = n; else delete window.__cashPaid[d];
  window.__cashChangeManual = false;
  cashSectionRefresh();
}
function cashChangeAdj(d, delta) {
  const cur = (window.__cashChange || {})[d] || 0;
  const n = Math.max(0, cur + delta);
  if (n > 0) window.__cashChange[d] = n; else delete window.__cashChange[d];
  window.__cashChangeManual = true;
  cashSectionRefresh();
}
function cashSuggestPay() {
  const amount = parseFloat((document.getElementById('exAmount') || {}).value) || 0;
  const { options, short } = computePayOptions(amount);
  if (short) { toast(isArabic() ? 'الكاش اللي معاك أقل من المبلغ' : "You don't have enough cash"); return; }
  if (!options.length) return;
  window.__cashPaid = Object.assign({}, options[0].counts);
  window.__cashChangeManual = false;
  cashSectionRefresh();
}
function cashChangeAuto() { window.__cashChangeManual = false; cashSectionRefresh(); }
function cashValidateAndBuild(amount) {
  const ar = isArabic();
  const paid = Object.assign({}, window.__cashPaid || {});
  const paidTotal = sumCounts(paid);
  if (paidTotal <= 0) return { paid: null, change: null }; // not tracking this one
  if (paidTotal + 0.13 < amount) return { error: ar ? 'الفئات اللي اخترتها أقل من المبلغ' : 'The bills you picked are less than the amount' };
  const expected = paidTotal - amount;
  const change = expected > 0.13 ? Object.assign({}, window.__cashChange || {}) : {};
  if (Math.abs(sumCounts(change) - (expected > 0.13 ? expected : 0)) > 0.13) return { error: ar ? 'مجموع الباقي مش مطابق للمفروض يرجعلك' : "The change total doesn't match what you should get back" };
  return { paid, change };
}

/* ---- "How did you pay?" — deduct from the cash manager automatically or ask ---- */
function cashAutoMsg(o) {
  const ar = isArabic();
  return `${ar ? 'اتخصم من الفكة' : 'Deducted'}: ${denSummary(o.counts)}` + (o.change > 0.001 ? ` · ${ar ? 'الباقي' : 'change'}: ${denSummary(o.changeCounts)}` : '');
}
function cashApplyOption(o) {
  window.__cashPaid = Object.assign({}, o.counts);
  window.__cashChange = Object.assign({}, o.changeCounts);
  window.__cashChangeManual = true;
}
function cashOptionsHtml(options, pickFn, editFn, skipFn) {
  const ar = isArabic(), cur = state.settings.currency;
  return options.map((o, i) => `
    <div class="card" style="margin-bottom:8px; ${i === 0 ? 'border-color:var(--primary-2);' : ''}">
      ${i === 0 ? `<span class="badge paid">${t('bestCombo')}</span>` : ''}
      <div class="t1" style="font-size:13.5px; font-weight:800; margin:6px 0 2px;">${denSummary(o.counts)}</div>
      <div class="small-note">${t('change')}: <b>${o.change > 0.001 ? fmt(o.change) + ' ' + cur : (ar ? 'مفيش' : 'none')}</b>${o.change > 0.001 ? ` (${denSummary(o.changeCounts)})` : ''}</div>
      <div class="btn-row" style="margin-top:8px;">
        <button type="button" class="btn btn-accent btn-sm" style="flex:1;" onclick="${pickFn}(${i})">✔ ${ar ? 'دفعت كده' : 'I paid this way'}</button>
        ${editFn ? `<button type="button" class="btn btn-outline btn-sm" onclick="${editFn}(${i})">✏️ ${ar ? 'عدّل' : 'Edit'}</button>` : ''}
      </div>
    </div>`).join('') + `<button type="button" class="btn btn-outline btn-sm" style="width:100%;" onclick="${skipFn}()">${ar ? 'من غير ما أتابع الفكة المرة دي' : "Don't track cash this time"}</button>`;
}
// For forms already on screen (expense / trip). Returns true when the caller may go on saving.
function cashGate(amount, saveFn) {
  if (cashTotal() <= 0) return true;                               // cash manager not in use
  if (sumCounts(window.__cashPaid) > 0 || window.__cashSkip) return true; // user already chose
  const { options, short } = computePayOptions(amount);
  if (short) { toast(isArabic() ? 'الفكة المسجلة أقل من المبلغ — اتسجل من غير خصم' : 'Tracked cash is less than this amount — saved without deducting'); window.__cashSkip = true; return true; }
  if (!options.length) return true;
  if (state.settings.cashAutoDeduct) { cashApplyOption(options[0]); toast(cashAutoMsg(options[0])); return true; }
  const sec = document.getElementById('cashSection');
  if (!sec) return true;
  window.__cashAskFn = saveFn; window.__cashAskOpts = options;
  sec.innerHTML = `<div class="cash-box" style="border-color:var(--primary-2);">
    <div class="cash-title">💵 ${isArabic() ? `دفعت ${fmt(amount)} إزاي؟` : `How did you pay ${fmt(amount)}?`}</div>
    ${cashOptionsHtml(options, 'cashAskPick', 'cashAskEdit', 'cashAskSkip')}</div>`;
  sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return false;
}
function cashAskPick(i) { const o = (window.__cashAskOpts || [])[i]; if (!o) return; cashApplyOption(o); const fn = window.__cashAskFn; if (fn) fn(); }
function cashAskEdit(i) { const o = (window.__cashAskOpts || [])[i]; if (!o) return; cashApplyOption(o); cashSectionRefresh(); }
function cashAskSkip() { window.__cashSkip = true; const fn = window.__cashAskFn; if (fn) fn(); }

// For one-tap flows with no form (quick-add buttons): auto, or a small sheet to ask.
function cashResolve(amount, walletId, finish) {
  if (!isCashWalletId(walletId) || cashTotal() <= 0) { finish(null, null); return; }
  const { options, short } = computePayOptions(amount);
  if (short || !options.length) { toast(isArabic() ? 'الفكة المسجلة أقل من المبلغ — اتسجل من غير خصم' : 'Tracked cash is less than this amount — saved without deducting'); finish(null, null); return; }
  if (state.settings.cashAutoDeduct) { toast(cashAutoMsg(options[0])); finish(options[0].counts, options[0].changeCounts); return; }
  window.__cashResolveOpts = options; window.__cashResolveFinish = finish;
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>💵 ${isArabic() ? `دفعت ${fmt(amount)} إزاي؟` : `How did you pay ${fmt(amount)}?`}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    ${cashOptionsHtml(options, 'cashResolvePick', null, 'cashResolveSkip')}
  `);
}
function cashResolvePick(i) { const o = window.__cashResolveOpts[i]; const f = window.__cashResolveFinish; if (o && f) f(o.counts, o.changeCounts); }
function cashResolveSkip() { const f = window.__cashResolveFinish; if (f) f(null, null); }

/* ============================== TRANSPORT (طرق المواصلات) ============================== */
const VEHICLES = [{ k: 'microbus', ic: '🚐' }, { k: 'bus', ic: '🚌' }, { k: 'train', ic: '🚆' }, { k: 'taxi', ic: '🚕' }, { k: 'uber', ic: '📱' }, { k: 'car', ic: '🚗' }];
const CAT_EMOJIS = ['🎓', '💼', '🏠', '📚', '🏋️', '🛒', '🏥', '👨‍👩‍👧', '⚽', '🧭'];
function vehIcon(k) { const v = VEHICLES.find(x => x.k === k); return v ? v.ic : '🚌'; }
function tripsOf() { return state.transactions.filter(x => x.type === 'expense' && x.routeId); }
function transportEnvId() {
  if (getEnvelope('env_transport')) return 'env_transport';
  const e = state.envelopes.find(x => x.key === 'transport') || state.envelopes[0];
  return e ? e.id : null;
}

/* ---- categories (الأقسام): add / edit / delete ---- */
function transportCats() {
  if (!Array.isArray(state.transportCategories)) {
    const ar = isArabic();
    state.transportCategories = [
      { id: 'tc_college', name: ar ? 'الكلية' : 'College', icon: '🎓' },
      { id: 'tc_work', name: ar ? 'الشغل' : 'Work', icon: '💼' },
      { id: 'tc_other', name: ar ? 'مشاوير تانية' : 'Other', icon: '🧭' },
    ];
  }
  return state.transportCategories;
}
function catOf(id) { return transportCats().find(c => c.id === id) || null; }
function openCatsSheet() {
  const ar = isArabic();
  const cats = transportCats();
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>🗂 ${ar ? 'أقسام المواصلات' : 'Transport categories'}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="card">
      ${cats.length === 0 ? `<div class="small-note">${ar ? 'مفيش أقسام' : 'No categories'}</div>` : cats.map(c => {
        const n = state.transportRoutes.filter(r => r.catId === c.id).length;
        return `<div class="list-row"><div class="ico-badge">${c.icon}</div><div class="mid"><div class="t1">${escAttr(c.name)}</div><div class="t2">${n} ${ar ? 'طريق' : 'routes'}</div></div>
          <button class="step-btn" onclick="openCatEditSheet('${c.id}')">✏️</button>
          <button class="step-btn" style="margin-inline-start:6px;" onclick="deleteCat('${c.id}')">🗑</button></div>`;
      }).join('')}
    </div>
    <button class="btn btn-primary" onclick="openCatEditSheet()">➕ ${ar ? 'إضافة قسم' : 'Add category'}</button>
  `);
}
function openCatEditSheet(id) {
  const ar = isArabic();
  const c = id ? catOf(id) : null;
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${c ? (ar ? 'تعديل القسم' : 'Edit category') : (ar ? 'قسم جديد' : 'New category')}</h3><button class="icon-btn" onclick="openCatsSheet()">✕</button></div>
    <div class="form-group"><label>${ar ? 'اسم القسم' : 'Name'}</label><input type="text" id="catName" value="${escAttr(c ? c.name : '')}" placeholder="${ar ? 'مثلاً: الجيم' : 'e.g. Gym'}"></div>
    <div class="form-group"><label>${ar ? 'الأيقونة' : 'Icon'}</label>
      <input type="text" id="catIcon" maxlength="4" value="${escAttr(c ? c.icon : '🧭')}" style="font-size:22px; text-align:center;">
      <div class="filter-chips" style="margin-top:8px; flex-wrap:wrap;">${CAT_EMOJIS.map(e => `<div class="chip" onclick="document.getElementById('catIcon').value='${e}'">${e}</div>`).join('')}</div>
    </div>
    <button class="btn btn-primary" onclick="saveCat('${id || ''}')">${t('save')}</button>
  `);
}
function saveCat(id) {
  const name = document.getElementById('catName').value.trim();
  const icon = document.getElementById('catIcon').value.trim() || '🧭';
  if (!name) { toast(isArabic() ? 'اكتب اسم القسم' : 'Enter a name'); return; }
  if (id) { const c = catOf(id); if (c) { c.name = name; c.icon = icon; } }
  else transportCats().push({ id: uid(), name, icon });
  saveState(); render(); openCatsSheet();
}
function deleteCat(id) {
  const ar = isArabic();
  const c = catOf(id); if (!c) return;
  const n = state.transportRoutes.filter(r => r.catId === id).length;
  const msg = n ? (ar ? `القسم "${c.name}" فيه ${n} طريق. هيتنقلوا لـ "بدون قسم". تمسحه؟` : `"${c.name}" has ${n} routes. They'll move to "No category". Delete?`)
                : (ar ? `تمسح قسم "${c.name}"؟` : `Delete "${c.name}"?`);
  if (!confirm(msg)) return;
  state.transportRoutes.forEach(r => { if (r.catId === id) r.catId = null; });
  state.transportCategories = transportCats().filter(x => x.id !== id);
  if (window.__trCat === id) window.__trCat = 'all';
  saveState(); render(); openCatsSheet();
}

/* ---- routes: a fixed route is one or more legs (e.g. microbus 5 + tuk-tuk 3) ---- */
function routeLegs(r) {
  if (Array.isArray(r.legs) && r.legs.length) return r.legs;
  return [{ vehicle: r.vehicle || 'bus', price: Number(r.price) || 0, label: '' }];
}
function routeOneWay(r) { return routeLegs(r).reduce((a, l) => a + (Number(l.price) || 0), 0); }
function routeLegsLine(r) { return routeLegs(r).map(l => `${vehIcon(l.vehicle)} ${fmt(l.price)}`).join(' + '); }

function routeCardHtml(r) {
  const ar = isArabic(), cur = state.settings.currency;
  const legs = routeLegs(r);
  return `
    <div class="card">
      <div class="list-row" style="border:none; padding:0 0 8px;">
        <div class="ico-badge">${legs.length > 1 ? '🔀' : vehIcon(legs[0].vehicle)}</div>
        <div class="mid"><div class="t1">${escAttr(r.name)}</div>
          <div class="t2">${escAttr(r.from || '')}${r.from && r.to ? ' ← ' : ''}${escAttr(r.to || '')}</div></div>
        <div class="amt neu">${fmt(routeOneWay(r))} ${cur}</div>
      </div>
      <div class="small-note" style="margin-bottom:10px;">${routeLegsLine(r)}${r.roundTrip ? ` · <span class="badge paid">${ar ? 'ذهاب وعودة' : 'round trip'}</span>` : ''}</div>
      <div class="btn-row">
        <button class="btn btn-accent btn-sm" style="flex:1;" onclick="openTripSheet('${r.id}')">🚍 ${t('logTrip')}</button>
        <button class="btn btn-outline btn-sm" onclick="openRouteSheet('${r.id}')">✏️</button>
      </div>
    </div>`;
}
function renderTransportRoutes() {
  const ar = isArabic();
  if (!Array.isArray(state.transportRoutes)) state.transportRoutes = [];
  const cats = transportCats();
  const flt = window.__trCat || 'all';
  const hasOrphans = state.transportRoutes.some(r => !catOf(r.catId));
  const groups = [...cats.map(c => ({ id: c.id, label: `${c.icon} ${escAttr(c.name)}`, routes: state.transportRoutes.filter(r => r.catId === c.id) })),
                  { id: 'none', label: `📂 ${ar ? 'بدون قسم' : 'No category'}`, routes: state.transportRoutes.filter(r => !catOf(r.catId)) }]
    .filter(g => g.routes.length && (flt === 'all' || flt === g.id));
  return `
    <p class="small-note" style="margin:0 0 12px;">${t('routesSub')}</p>
    <div class="btn-row" style="margin-bottom:12px;">
      <button class="btn btn-primary" onclick="openRouteSheet()">➕ ${t('addRoute')}</button>
      <button class="btn btn-outline" onclick="openCatsSheet()">🗂 ${ar ? 'الأقسام' : 'Categories'}</button>
    </div>
    ${cats.length ? `<div class="filter-chips"><div class="chip ${flt === 'all' ? 'selected' : ''}" onclick="window.__trCat='all'; render();">${t('all') || (ar ? 'الكل' : 'All')}</div>
      ${cats.map(c => `<div class="chip ${flt === c.id ? 'selected' : ''}" onclick="window.__trCat='${c.id}'; render();">${c.icon} ${escAttr(c.name)}</div>`).join('')}
      ${hasOrphans ? `<div class="chip ${flt === 'none' ? 'selected' : ''}" onclick="window.__trCat='none'; render();">📂 ${ar ? 'بدون قسم' : 'None'}</div>` : ''}</div>` : ''}
    ${groups.length === 0 ? emptyState('🚍', t('noRoutes'), '') : groups.map(g => `
      <div class="section-head"><h2>${g.label}</h2><span class="small-note">${g.routes.length}</span></div>
      ${g.routes.map(routeCardHtml).join('')}`).join('')}
  `;
}

/* route editor sheet */
function rtLegsHtml() {
  const ar = isArabic();
  const legs = window.__rtLegs || [];
  return legs.map((l, i) => `
    <div class="den-row" style="gap:6px;">
      <select style="flex:1.3;" onchange="rtLegSet(${i},'vehicle',this.value)">${VEHICLES.map(v => `<option value="${v.k}" ${l.vehicle === v.k ? 'selected' : ''}>${v.ic} ${t(v.k)}</option>`).join('')}</select>
      <input type="number" inputmode="decimal" style="flex:1; min-width:0;" placeholder="${ar ? 'السعر' : 'Price'}" value="${escAttr(l.price === '' || l.price == null ? '' : l.price)}" oninput="rtLegSet(${i},'price',this.value)">
      ${legs.length > 1 ? `<button type="button" class="step-btn" onclick="rtLegDel(${i})">✕</button>` : ''}
    </div>`).join('') + `<div class="split-total ok" id="rtLegsTotal">${rtTotalText()}</div>`;
}
function rtTotalText() {
  const ar = isArabic();
  const one = (window.__rtLegs || []).reduce((a, l) => a + (parseFloat(l.price) || 0), 0);
  const round = (document.getElementById('rtRound') || {}).checked;
  return `${ar ? 'إجمالي الاتجاه الواحد' : 'One way'}: ${fmt(one)} ${state.settings.currency}${round ? ` · ${ar ? 'ذهاب وعودة' : 'round trip'}: ${fmt(one * 2)}` : ''}`;
}
function rtLegSet(i, k, v) {
  if (!window.__rtLegs[i]) return;
  window.__rtLegs[i][k] = v;
  const el = document.getElementById('rtLegsTotal'); if (el) el.textContent = rtTotalText();
}
function rtLegAdd() { window.__rtLegs.push({ vehicle: 'microbus', price: '' }); document.getElementById('rtLegs').innerHTML = rtLegsHtml(); }
function rtLegDel(i) { window.__rtLegs.splice(i, 1); document.getElementById('rtLegs').innerHTML = rtLegsHtml(); }
function openRouteSheet(id) {
  const ar = isArabic();
  const r = id ? state.transportRoutes.find(x => x.id === id) : null;
  window.__rtLegs = r ? routeLegs(r).map(l => ({ vehicle: l.vehicle, price: l.price })) : [{ vehicle: 'microbus', price: '' }];
  const cats = transportCats();
  const selCat = r ? r.catId : (window.__trCat && catOf(window.__trCat) ? window.__trCat : (cats[0] ? cats[0].id : ''));
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${r ? t('editRoute') : t('addRoute')}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="form-group"><label>${t('routeName')}</label><input type="text" id="rtName" value="${escAttr(r ? r.name : '')}" placeholder="${ar ? 'مثلاً: البيت ← الكلية' : 'e.g. Home → College'}"></div>
    <div class="form-group"><label>${ar ? 'القسم' : 'Category'}</label>
      <select id="rtCat"><option value="">📂 ${ar ? 'بدون قسم' : 'No category'}</option>${cats.map(c => `<option value="${c.id}" ${c.id === selCat ? 'selected' : ''}>${c.icon} ${escAttr(c.name)}</option>`).join('')}</select></div>
    <div class="form-group"><label>${t('fromLocation')}</label><input type="text" id="rtFrom" value="${escAttr(r ? r.from : '')}"></div>
    <div class="form-group"><label>${t('toLocation')}</label><input type="text" id="rtTo" value="${escAttr(r ? r.to : '')}"></div>
    <div class="form-group"><label>${ar ? 'الركوبات (لو الطريق فيه أكتر من مواصلة زوّدها)' : 'Rides on this route (add more if you change vehicles)'}</label>
      <div id="rtLegs">${rtLegsHtml()}</div>
      <button type="button" class="btn btn-outline btn-sm" style="margin-top:8px;" onclick="rtLegAdd()">➕ ${ar ? 'إضافة مواصلة' : 'Add a ride'}</button>
    </div>
    <label class="den-row" style="cursor:pointer;"><span class="den-name">${ar ? 'غالباً بروح وأرجع (ذهاب وعودة)' : 'Usually round trip'}</span><input type="checkbox" id="rtRound" ${r && r.roundTrip ? 'checked' : ''} onchange="document.getElementById('rtLegsTotal').textContent = rtTotalText()"></label>
    <button class="btn btn-primary" style="margin-top:14px;" onclick="saveRoute('${id || ''}')">${t('save')}</button>
    ${r ? `<button class="btn btn-danger" style="margin-top:10px;" onclick="deleteRoute('${id}')">🗑️ ${t('delete')}</button>` : ''}
  `);
}
function saveRoute(id) {
  const ar = isArabic();
  const name = document.getElementById('rtName').value.trim();
  const legs = (window.__rtLegs || []).map(l => ({ vehicle: l.vehicle, price: parseFloat(l.price) })).filter(l => l.price >= 0);
  const one = legs.reduce((a, l) => a + l.price, 0);
  if (!name || !legs.length || !(one > 0)) { toast(ar ? 'اكتب اسم الطريق وسعر المواصلة' : 'Enter a route name and a price'); return; }
  const data = {
    name, legs, price: one, vehicle: legs[0].vehicle, icon: legs.length > 1 ? '🔀' : vehIcon(legs[0].vehicle),
    from: document.getElementById('rtFrom').value.trim(), to: document.getElementById('rtTo').value.trim(),
    catId: document.getElementById('rtCat').value || null, roundTrip: document.getElementById('rtRound').checked,
  };
  if (id) Object.assign(state.transportRoutes.find(x => x.id === id) || {}, data);
  else state.transportRoutes.push(Object.assign({ id: uid() }, data));
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}
function deleteRoute(id) {
  if (!confirm(isArabic() ? 'تمسح الطريق ده؟ (الرحلات اللي اتسجلت قبل كده هتفضل زي ما هي)' : 'Delete this route? (Logged trips are kept)')) return;
  state.transportRoutes = state.transportRoutes.filter(x => x.id !== id);
  saveState(); closeSheet(); render();
}

/* ---- logging a trip: pay from cash with bills + change (linked to the cash manager) ---- */
function tripTotal() {
  const r = state.transportRoutes.find(x => x.id === window.__tripRoute); if (!r) return 0;
  return routeOneWay(r) * (window.__tripRound ? 2 : 1);
}
function openTripSheet(id) {
  const ar = isArabic();
  const r = state.transportRoutes.find(x => x.id === id); if (!r) return;
  window.__tripRoute = id; window.__tripRound = !!r.roundTrip;
  window.__cashPaid = {}; window.__cashChange = {}; window.__cashChangeManual = false; window.__cashSkip = false;
  const cashWal = state.wallets.find(w => w.key === 'cash' || w.id === 'wal_cash');
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>🚍 ${escAttr(r.name)}</h3><button class="icon-btn" onclick="closeSheet()">✕</button></div>
    <div class="small-note" style="margin-bottom:10px;">${routeLegsLine(r)}</div>
    <div class="filter-chips" style="margin-bottom:12px;">
      <div class="chip ${window.__tripRound ? '' : 'selected'}" id="tripOne" onclick="tripSetRound(false)">${ar ? 'ذهاب بس' : 'One way'}</div>
      <div class="chip ${window.__tripRound ? 'selected' : ''}" id="tripRound" onclick="tripSetRound(true)">${ar ? 'ذهاب وعودة' : 'Round trip'}</div>
    </div>
    <div class="form-group"><label>${ar ? 'الإجمالي' : 'Total'}</label><input type="number" inputmode="decimal" id="exAmount" value="${tripTotal()}" oninput="cashSectionRefresh()"></div>
    <div class="form-group"><label>${t('date')}</label><input type="date" id="exDate" value="${todayStr()}"></div>
    <div class="form-group"><label>${t('wallet')}</label>
      <select id="exWallet" onchange="cashWalletChanged()">${state.wallets.map(w => `<option value="${w.id}" ${cashWal && w.id === cashWal.id ? 'selected' : ''}>${w.icon} ${walLabel(w)}</option>`).join('')}</select></div>
    <div id="cashSection"></div>
    <button class="btn btn-primary" onclick="saveTrip()">${t('save')}</button>
  `);
  cashWalletChanged();
}
function tripSetRound(b) {
  window.__tripRound = b;
  document.getElementById('tripOne').classList.toggle('selected', !b);
  document.getElementById('tripRound').classList.toggle('selected', b);
  document.getElementById('exAmount').value = tripTotal();
  window.__cashPaid = {}; window.__cashChange = {}; window.__cashChangeManual = false;
  cashSectionRefresh();
}
function saveTrip() {
  const ar = isArabic();
  const r = state.transportRoutes.find(x => x.id === window.__tripRoute); if (!r) return;
  const amount = parseFloat(document.getElementById('exAmount').value);
  if (!(amount > 0)) { toast(ar ? 'اكتب مبلغ صحيح' : 'Enter a valid amount'); return; }
  const walletId = document.getElementById('exWallet').value;
  const date = document.getElementById('exDate').value || todayStr();
  let cashInfo = null;
  if (isCashWalletId(walletId)) {
    if (!cashGate(amount, saveTrip)) return;
    const v = cashValidateAndBuild(amount);
    if (v.error) { toast(v.error); return; }
    cashInfo = v;
  }
  const envelopeId = transportEnvId();
  if (!envelopeId) { toast(ar ? 'مفيش قسم مصاريف متاح' : 'No spending category available'); return; }
  const legs = routeLegs(r).map(l => ({ vehicle: l.vehicle, price: Number(l.price) || 0 }));
  const tripLegs = window.__tripRound ? legs.concat(legs) : legs;
  const cashFields = (cashInfo && cashInfo.paid) ? { cashPaid: cashInfo.paid, cashChange: cashInfo.change } : {};
  if (cashFields.cashPaid) applyCashMovement(cashFields.cashPaid, cashFields.cashChange, +1);
  state.transactions.push(Object.assign({
    id: uid(), type: 'expense', amount, envelopeId, date, walletId, createdAt: Date.now(),
    description: r.name + (window.__tripRound ? (ar ? ' (ذهاب وعودة)' : ' (round trip)') : ''),
    routeId: r.id, vehicle: tripLegs[0].vehicle, tripLegs, roundTrip: !!window.__tripRound, transportCatId: r.catId || null,
  }, cashFields));
  saveState(); closeSheet(); toast(t('savedSuccess')); render();
}

/* ---- report ---- */
function renderTransportReport() {
  const ar = isArabic(), cur = state.settings.currency;
  const trips = tripsOf();
  if (!trips.length) return emptyState('📊', ar ? 'لسه مفيش رحلات متسجلة' : 'No trips logged yet', t('routesSub'));
  const monthKey = todayStr().slice(0, 7);
  const byRoute = {}, byVeh = {}, byCat = {};
  trips.forEach(x => {
    byRoute[x.routeId] = byRoute[x.routeId] || { n: 0, sum: 0 }; byRoute[x.routeId].n++; byRoute[x.routeId].sum += x.amount;
    const cid = catOf(x.transportCatId) ? x.transportCatId : 'none';
    byCat[cid] = byCat[cid] || { n: 0, sum: 0 }; byCat[cid].n++; byCat[cid].sum += x.amount;
    const legs = Array.isArray(x.tripLegs) && x.tripLegs.length ? x.tripLegs : [{ vehicle: x.vehicle || 'bus', price: x.amount }];
    legs.forEach(l => { byVeh[l.vehicle] = byVeh[l.vehicle] || { n: 0, sum: 0 }; byVeh[l.vehicle].n++; byVeh[l.vehicle].sum += Number(l.price) || 0; });
  });
  const topRouteId = Object.keys(byRoute).sort((a, b) => byRoute[b].n - byRoute[a].n)[0];
  const topRoute = state.transportRoutes.find(r => r.id === topRouteId);
  const topVeh = Object.keys(byVeh).sort((a, b) => byVeh[b].n - byVeh[a].n)[0];
  const total = trips.reduce((a, x) => a + x.amount, 0);
  const recent = trips.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8);
  return `
    <div class="month-row">
      <div class="month-card"><div class="v">${trips.length}</div><div class="l">${t('totalTrips')}</div></div>
      <div class="month-card"><div class="v">${trips.filter(x => String(x.date).slice(0, 7) === monthKey).length}</div><div class="l">${t('tripsThisMonth')}</div></div>
    </div>
    <div class="card">
      <div class="list-row"><div class="mid t1">${t('totalTransportSpent')}</div><div class="amt neg">${fmt(total)} ${cur}</div></div>
      <div class="list-row"><div class="mid t1">${t('mostUsedRoute')}</div><div class="amt neu">${topRoute ? escAttr(topRoute.name) : '—'}</div></div>
      <div class="list-row"><div class="mid t1">${t('mostUsedVehicle')}</div><div class="amt neu">${vehIcon(topVeh)} ${t(topVeh)}</div></div>
    </div>
    <div class="section-head"><h2>🗂 ${ar ? 'حسب القسم' : 'By category'}</h2></div>
    <div class="card">${Object.keys(byCat).sort((a, b) => byCat[b].sum - byCat[a].sum).map(cid => { const c = catOf(cid); return `
      <div class="list-row"><div class="ico-badge">${c ? c.icon : '📂'}</div><div class="mid"><div class="t1">${c ? escAttr(c.name) : (ar ? 'بدون قسم' : 'No category')}</div><div class="t2">${byCat[cid].n} ${ar ? 'رحلة' : 'trips'}</div></div><div class="amt neg">${fmt(byCat[cid].sum)} ${cur}</div></div>`; }).join('')}</div>
    <div class="section-head"><h2>${t('vehicleStats')}</h2></div>
    <div class="card">${Object.keys(byVeh).sort((a, b) => byVeh[b].n - byVeh[a].n).map(v => `
      <div class="list-row"><div class="ico-badge">${vehIcon(v)}</div><div class="mid"><div class="t1">${t(v)}</div><div class="t2">${byVeh[v].n} ${ar ? 'ركوبة' : 'rides'}</div></div><div class="amt neg">${fmt(byVeh[v].sum)} ${cur}</div></div>`).join('')}</div>
    <div class="section-head"><h2>${ar ? 'آخر الرحلات' : 'Recent trips'}</h2></div>
    <div class="card">${recent.map(x => `
      <div class="list-row"><div class="mid"><div class="t1">${escAttr(x.description || '')}</div><div class="t2">${x.date}${x.cashPaid ? ` · 💵 ${denSummary(x.cashPaid)}` : ''}${x.cashChange && Object.keys(x.cashChange).length ? ` · ↩️ ${denSummary(x.cashChange)}` : ''}</div></div><div class="amt neg">${fmt(x.amount)} ${cur}</div></div>`).join('')}</div>
  `;
}
