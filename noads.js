/*!
 * NoAds — плагин для Lampa, убирающий рекламу.
 * Версия: 1.0.0
 *
 * Что делает (несколько независимых слоёв, чтобы реклама не пролезла,
 * даже если Lampa что-то переименует в следующей версии):
 *   1. Сеть: блокирует загрузку рекламного инвентаря CUB (/api/ad/...)
 *      и запросы к известным рекламным сетям (XHR + fetch).
 *   2. Плеер: вычищает vast_url / preroll-поля, которые подсовывают
 *      сторонние плагины-балансеры, и глушит модуль Preroll, если он доступен.
 *   3. DOM: если рекламный ролик всё же стартовал — мгновенно глушит звук,
 *      прокручивает его до конца и жмёт «Пропустить»; скрывает баннеры,
 *      рекламные карточки и промо-блоки и убирает их из навигации пульта.
 *   4. (опционально) «Жёсткий режим» — заставляет Lampa считать запуск
 *      безрекламным на этапе проверки преролла.
 *
 * Установка: Настройки → Расширения → Добавить плагин → URL этого файла.
 * Код написан на ES5, чтобы работать на старых webOS / Tizen.
 */
(function () {
    'use strict';

    if (window.__lampa_noads_loaded) return;
    window.__lampa_noads_loaded = true;

    var VERSION = '1.0.0';
    var TAG = '[NoAds]';

    /* ------------------------------------------------------------------ */
    /*  Настройки                                                          */
    /* ------------------------------------------------------------------ */

    function readBool(key, def) {
        var v;
        try {
            if (window.Lampa && Lampa.Storage && Lampa.Storage.get) {
                v = Lampa.Storage.get(key, def);
            } else {
                v = window.localStorage.getItem(key);
                if (v === null) v = def;
            }
        } catch (e) {
            v = def;
        }
        return v === true || v === 'true';
    }

    var ENABLED = readBool('noads_enabled', true);
    var HARD = readBool('noads_hard', false);

    var stats = { requests: 0, videos: 0, nodes: 0, players: 0 };

    function log() {
        try {
            var args = [TAG];
            for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
            console.log.apply(console, args);
        } catch (e) { /* ignore */ }
    }

    if (!ENABLED) {
        log('выключен в настройках, v' + VERSION);
        onReady(addSettings);
        return;
    }

    /* ------------------------------------------------------------------ */
    /*  Слой 1. Сеть                                                       */
    /* ------------------------------------------------------------------ */

    // Рекламные домены (матчится сам домен и все его поддомены).
    var AD_DOMAINS = [
        'imasdk.googleapis.com',
        'doubleclick.net',
        'googlesyndication.com',
        'googleadservices.com',
        'an.yandex.ru',
        'adfox.yandex.ru',
        'adfox.ru',
        'adriver.ru',
        'betweendigital.com',
        'buzzoola.com',
        'otm-r.com',
        'hybrid.ai',
        'mediasniper.ru',
        'adhigh.net',
        'videonow.ru',
        'moevideo.biz',
        'admixer.net',
        'ad.mail.ru'
    ];

    // Шаблоны пути — для любых хостов (зеркала CUB постоянно меняются).
    var AD_PATHS = [
        /\/api\/ad\//i,          // инвентарь CUB: /api/ad/get/preroll, /api/ad/get/banner …
        /\/vast\.xml(\?|$)/i,
        /[?&]vast(_url|_tag)?=/i
    ];

    var DOMAIN_RE = [];
    for (var d = 0; d < AD_DOMAINS.length; d++) {
        var esc = AD_DOMAINS[d].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        DOMAIN_RE.push(new RegExp('^(?:[a-z]+:)?//(?:[^/?#@]*@)?(?:[^/?#]*\\.)?' + esc + '(?=[:/?#]|$)', 'i'));
    }

    function isBlocked(url) {
        if (!url) return false;
        url = String(url);
        var i;
        for (i = 0; i < AD_PATHS.length; i++) if (AD_PATHS[i].test(url)) return true;
        for (i = 0; i < DOMAIN_RE.length; i++) if (DOMAIN_RE[i].test(url)) return true;
        return false;
    }

    // экспорт для отладки / тестов
    window.__lampa_noads = { isBlocked: isBlocked, stats: stats, version: VERSION };

    function makeEvent(type) {
        try {
            return new Event(type);
        } catch (e) {
            try {
                var ev = document.createEvent('Event');
                ev.initEvent(type, false, false);
                return ev;
            } catch (e2) {
                return null;
            }
        }
    }

    function emit(target, type) {
        var ev = makeEvent(type);
        if (ev && target.dispatchEvent) {
            try {
                target.dispatchEvent(ev); // вызывает и addEventListener-слушателей, и on<type>
                return;
            } catch (e) { /* fallthrough */ }
        }
        if (typeof target['on' + type] === 'function') {
            try { target['on' + type](ev); } catch (e3) { /* ignore */ }
        }
    }

    function setProp(obj, name, value) {
        try {
            Object.defineProperty(obj, name, { value: value, configurable: true, writable: true });
        } catch (e) { /* ignore */ }
    }

    // Имитируем обычную сетевую ошибку: readystatechange(DONE) → error → loadend.
    // Код, который грузит рекламу, видит «сервер недоступен» и просто идёт дальше.
    function failXHR(xhr) {
        setProp(xhr, 'readyState', 4);
        setProp(xhr, 'status', 0);
        setProp(xhr, 'statusText', '');
        setProp(xhr, 'responseText', '');
        setProp(xhr, 'response', '');
        emit(xhr, 'readystatechange');
        emit(xhr, 'error');
        emit(xhr, 'loadend');
    }

    function hookXHR() {
        var XHR = window.XMLHttpRequest;
        if (!XHR || !XHR.prototype || XHR.prototype.__noads) return;

        var nativeOpen = XHR.prototype.open;
        var nativeSend = XHR.prototype.send;

        XHR.prototype.open = function (method, url) {
            this.__noads_block = isBlocked(url);
            if (this.__noads_block) this.__noads_url = url;
            return nativeOpen.apply(this, arguments);
        };

        XHR.prototype.send = function () {
            if (!this.__noads_block) return nativeSend.apply(this, arguments);
            var xhr = this;
            stats.requests++;
            log('заблокирован запрос', xhr.__noads_url);
            setTimeout(function () { failXHR(xhr); }, 0);
        };

        XHR.prototype.__noads = true;
    }

    function hookFetch() {
        if (typeof window.fetch !== 'function' || window.fetch.__noads) return;
        var nativeFetch = window.fetch;
        var wrapped = function (input) {
            var url = input && typeof input === 'object' && input.url ? input.url : input;
            if (isBlocked(url)) {
                stats.requests++;
                log('заблокирован fetch', url);
                return Promise.reject(new TypeError('NoAds: blocked'));
            }
            return nativeFetch.apply(this, arguments);
        };
        wrapped.__noads = true;
        window.fetch = wrapped;
    }

    // Ставим сразу, не дожидаясь готовности приложения:
    // чем раньше, тем больше рекламных запросов перехватим.
    hookXHR();
    hookFetch();

    /* ------------------------------------------------------------------ */
    /*  Слой 2. Плеер и модули рекламы                                     */
    /* ------------------------------------------------------------------ */

    var AD_FIELD_RE = /^(vast|preroll|midroll|postroll|advert)/i;

    function cleanItem(item) {
        if (!item || typeof item !== 'object') return;
        for (var key in item) {
            if (Object.prototype.hasOwnProperty.call(item, key) && AD_FIELD_RE.test(key)) {
                try { delete item[key]; } catch (e) { item[key] = ''; }
            }
        }
    }

    function cleanPlayerData(data) {
        if (!data || typeof data !== 'object') return;
        cleanItem(data);
        if (data.playlist && data.playlist.length) {
            for (var i = 0; i < data.playlist.length; i++) cleanItem(data.playlist[i]);
        }
    }

    // ---- «жёсткий режим» ----
    // Lampa пропускает преролл для IPTV/торрентов/YouTube (getMediaType().any).
    // Пока плеер не стартовал, отдаём на чтение data.iptv = true, после старта
    // возвращаем настоящее значение. Выключено по умолчанию.
    var armed = [];

    function releaseArmed() {
        while (armed.length) {
            var data = armed.pop();
            try {
                Object.defineProperty(data, 'iptv', {
                    value: false, writable: true, configurable: true, enumerable: true
                });
            } catch (e) { /* ignore */ }
        }
    }

    function armHard(data) {
        if (!data || typeof data !== 'object' || data.iptv) return;
        try {
            Object.defineProperty(data, 'iptv', {
                configurable: true,
                enumerable: false,
                get: function () { return true; },
                set: function (v) {
                    Object.defineProperty(data, 'iptv', {
                        value: v, writable: true, configurable: true, enumerable: true
                    });
                }
            });
            armed.push(data);
            // страховка: если события старта так и не будет
            setTimeout(releaseArmed, 15000);
        } catch (e) { /* ignore */ }
    }

    function patchPlayer() {
        var P = window.Lampa && Lampa.Player;
        if (!P || typeof P.play !== 'function' || P.play.__noads) return;

        var nativePlay = P.play;
        var wrapped = function (data) {
            try {
                cleanPlayerData(data);
                if (HARD) armHard(data);
                stats.players++;
            } catch (e) { /* ignore */ }
            return nativePlay.apply(this, arguments);
        };
        wrapped.__noads = true;
        P.play = wrapped;

        if (typeof P.playlist === 'function' && !P.playlist.__noads) {
            var nativePlaylist = P.playlist;
            var wrappedPl = function (list) {
                try {
                    if (list && list.length) for (var i = 0; i < list.length; i++) cleanItem(list[i]);
                } catch (e) { /* ignore */ }
                return nativePlaylist.apply(this, arguments);
            };
            wrappedPl.__noads = true;
            P.playlist = wrappedPl;
        }

        if (P.listener && typeof P.listener.follow === 'function') {
            P.listener.follow('start', releaseArmed);
            P.listener.follow('external', releaseArmed);
            P.listener.follow('destroy', releaseArmed);
            P.listener.follow('ready', releaseArmed);
        }
    }

    // Если какой-то модуль рекламы выставлен в window.Lampa — глушим его show():
    // сразу вызываем колбэк «реклама закончилась».
    var AD_MODULES = ['Preroll', 'Advert', 'Ad', 'Ads', 'AdPreroll', 'VastPreroll'];

    function patchAdModules() {
        if (!window.Lampa) return;
        for (var i = 0; i < AD_MODULES.length; i++) {
            var m = Lampa[AD_MODULES[i]];
            if (!m || typeof m.show !== 'function' || m.show.__noads) continue;
            var stub = function () {
                for (var j = arguments.length - 1; j >= 0; j--) {
                    if (typeof arguments[j] === 'function') {
                        try { arguments[j](); } catch (e) { log(e); }
                        return;
                    }
                }
            };
            stub.__noads = true;
            m.show = stub;
            log('модуль ' + AD_MODULES[i] + '.show заглушён');
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Слой 3. Интерфейс                                                  */
    /* ------------------------------------------------------------------ */

    // Полноэкранные рекламные оверлеи: делаем невидимыми, но не display:none,
    // чтобы ролик (если всё-таки начался) нормально «доиграл» и отдал управление.
    var OVERLAY_SELECTORS = ['.ad-preroll', '.ad-video-block'];

    // Статичная реклама и промо — убираем полностью.
    var STATIC_SELECTORS = [
        '.ad-countdown',
        '.ad-server',
        '.ad-card',
        '.ad-watched',
        '.ad-offer',
        '.ad-extend',
        '.ad-premiere',
        '.ad-bot',
        '.ad-banner',
        '.player-advert'
    ];

    function injectCSS() {
        if (document.getElementById('noads-style')) return;
        var css =
            OVERLAY_SELECTORS.join(',') +
            '{opacity:0!important;visibility:hidden!important;pointer-events:none!important}' +
            STATIC_SELECTORS.join(',') + ',.noads-hidden' +
            '{display:none!important}';
        var style = document.createElement('style');
        style.id = 'noads-style';
        style.type = 'text/css';
        style.appendChild(document.createTextNode(css));
        (document.head || document.documentElement).appendChild(style);
    }

    function killVideo(v) {
        if (!v || v.__noads) return;
        v.__noads = true;
        stats.videos++;
        try { v.muted = true; v.volume = 0; } catch (e) { /* ignore */ }

        var fastForward = function () {
            try {
                v.muted = true;
                if (isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.3) {
                    v.currentTime = Math.max(0, v.duration - 0.1);
                }
                v.playbackRate = 16;
            } catch (e) { /* ignore */ }
        };

        v.addEventListener('loadedmetadata', fastForward);
        v.addEventListener('durationchange', fastForward);
        v.addEventListener('playing', fastForward);
        v.addEventListener('timeupdate', fastForward);
        fastForward();
        log('рекламный ролик перемотан');
    }

    function pressSkip(block) {
        var btns = block.querySelectorAll('.ad-video-block__skip, [class*="__skip"]');
        for (var i = 0; i < btns.length; i++) {
            try {
                if (window.$) $(btns[i]).trigger('hover:enter');
                btns[i].click();
            } catch (e) { /* ignore */ }
        }
    }

    function hideStatic(el) {
        if (el.__noads) return;
        el.__noads = true;
        stats.nodes++;
        if (el.classList) {
            el.classList.add('noads-hidden');
            el.classList.remove('selector'); // чтобы пульт не «проваливался» в скрытый блок
        }
        var inner = el.querySelectorAll ? el.querySelectorAll('.selector') : [];
        for (var i = 0; i < inner.length; i++) inner[i].classList.remove('selector');
    }

    function scan() {
        var i, j, list;

        list = document.querySelectorAll(OVERLAY_SELECTORS.join(','));
        for (i = 0; i < list.length; i++) {
            var vids = list[i].querySelectorAll('video');
            for (j = 0; j < vids.length; j++) killVideo(vids[j]);
            pressSkip(list[i]);
        }

        list = document.querySelectorAll(STATIC_SELECTORS.join(','));
        for (i = 0; i < list.length; i++) hideStatic(list[i]);
    }

    var scanQueued = false;
    function queueScan() {
        if (scanQueued) return;
        scanQueued = true;
        setTimeout(function () {
            scanQueued = false;
            try { scan(); } catch (e) { log(e); }
        }, 50);
    }

    function watchDOM() {
        injectCSS();
        scan();
        var MO = window.MutationObserver || window.WebKitMutationObserver;
        if (MO && document.body) {
            new MO(queueScan).observe(document.body, { childList: true, subtree: true });
        } else {
            setInterval(scan, 1000);
        }
        // пока висит рекламный блок — продолжаем жать «Пропустить»
        setInterval(function () {
            var blocks = document.querySelectorAll('.ad-video-block');
            for (var i = 0; i < blocks.length; i++) pressSkip(blocks[i]);
        }, 500);
    }

    /* ------------------------------------------------------------------ */
    /*  Настройки в интерфейсе Lampa                                       */
    /* ------------------------------------------------------------------ */

    function notifyRestart() {
        try { Lampa.Noty.show('NoAds: перезапустите Лампу, чтобы применить'); } catch (e) { /* ignore */ }
    }

    function addSettings() {
        var S = window.Lampa && Lampa.SettingsApi;
        if (!S || typeof S.addComponent !== 'function') return;

        S.addComponent({
            component: 'noads',
            name: 'Без рекламы',
            icon: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                  '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>' +
                  '<path d="M5.6 5.6l12.8 12.8" stroke="currentColor" stroke-width="2"/></svg>'
        });

        S.addParam({
            component: 'noads',
            param: { name: 'noads_enabled', type: 'trigger', 'default': true },
            field: {
                name: 'Блокировать рекламу',
                description: 'Прероллы, баннеры в плеере, VAST от плагинов, промо-блоки'
            },
            onChange: notifyRestart
        });

        S.addParam({
            component: 'noads',
            param: { name: 'noads_hard', type: 'trigger', 'default': false },
            field: {
                name: 'Жёсткий режим прероллов',
                description: 'Включите, если реклама перед фильмом всё равно появляется. ' +
                             'Если плеер начнёт вести себя странно — выключите.'
            },
            onChange: notifyRestart
        });

        S.addParam({
            component: 'noads',
            param: { name: 'noads_stats', type: 'static' },
            field: { name: 'Статистика', description: '' },
            onRender: function (item) {
                try {
                    item.find('.settings-param__descr').text(
                        'v' + VERSION + ' · запросов заблокировано: ' + stats.requests +
                        ' · роликов перемотано: ' + stats.videos +
                        ' · блоков скрыто: ' + stats.nodes
                    );
                } catch (e) { /* ignore */ }
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Запуск                                                             */
    /* ------------------------------------------------------------------ */

    function onReady(fn) {
        if (window.appready) {
            fn();
        } else if (window.Lampa && Lampa.Listener && Lampa.Listener.follow) {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') fn();
            });
        } else {
            window.addEventListener('load', fn);
        }
    }

    // Плеер и модули патчим и сразу (если уже есть), и после ready.
    try { patchPlayer(); patchAdModules(); } catch (e) { log(e); }

    onReady(function () {
        try { patchPlayer(); } catch (e) { log(e); }
        try { patchAdModules(); } catch (e) { log(e); }
        try { watchDOM(); } catch (e) { log(e); }
        try { addSettings(); } catch (e) { log(e); }
        log('запущен, v' + VERSION + (HARD ? ' (жёсткий режим)' : ''));
    });
})();
