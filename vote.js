// 팀원 웹 투표. 로그인 없이 링크(?t=토큰)로 들어와 총무가 고른 후보 가게 중 가고 싶은 곳을 골라요.
// 후보는 Edge Function vote-places(토큰)로 불러오고, 투표는 Supabase RPC submit_place_vote(토큰, 가게 ID, 알레르기)로 넣어요.
// 가게 이름은 저장하지 않는 데이터라 서버가 그때그때 카카오에서 찾아 줘요.
// 알레르기 키는 앱 lib/domain/menus.dart, 서버 _shared/menus.ts 와 같아요.
(function () {
  "use strict";

  var ALLERGIES = [
    ["shellfish", "갑각류(새우·게)"],
    ["nuts", "견과류"],
    ["dairy", "유제품"],
    ["gluten", "밀·글루텐"],
    ["raw", "날음식(회)"],
    ["spicy", "매운 음식"],
    ["pork", "돼지고기"],
    ["alcohol", "술을 못 마셔요"],
  ];
  var WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
  /** 한 사람이 고를 수 있는 가게 수 */
  var MAX_PICKS = 3;
  /** 도보 1분 거리 (m) */
  var WALK_M_PER_MIN = 80;
  /** 이보다 멀면 걸어서 몇 분 대신 km로 보여 줘요 (m) */
  var NEAR_LIMIT_M = 1200;
  /** 데모 모드용 가상 가게 (이름은 모두 지어낸 것이라 카카오맵 링크는 없어요) */
  var DEMO_PLACES = [
    { id: "k_9001", name: "달빛화로 본점", category: "음식점 > 한식 > 육류,고기", address: "가상로 100", place_url: null, distance_m: 216 },
    { id: "k_9016", name: "고래별 스시", category: "음식점 > 일식 > 초밥,롤", address: "가상로 107", place_url: null, distance_m: 581 },
    { id: "k_9021", name: "낮달 이자카야", category: "음식점 > 술집 > 일본식주점", address: "가상로 114", place_url: null, distance_m: 361 },
    { id: "k_9006", name: "파도소리 횟집", category: "음식점 > 한식 > 해물,생선 > 회", address: "가상로 121", place_url: null, distance_m: 568 },
  ];

  var MSG_INVALID = "링크가 올바르지 않습니다. 총무에게 받은 링크로 다시 들어와 주십시오.";
  var MSG_CLOSED = "투표가 이미 마감됐습니다. 총무가 곧 장소를 알려 드릴 겁니다.";
  var MSG_TROUBLE = "잠시 문제가 생겼습니다. 조금 뒤에 다시 열어 주십시오.";

  var cfg = window.HOESIK_CONFIG || {};
  var token = new URLSearchParams(location.search).get("t") || "";
  var demo = !(cfg.supabaseUrl && cfg.supabaseKey) || token === "demo";
  var $ = function (id) { return document.getElementById(id); };
  var state = { places: [], allergies: new Set() };

  function baseUrl() { return cfg.supabaseUrl.replace(/\/$/, ""); }
  function headers() {
    return {
      "Content-Type": "application/json",
      apikey: cfg.supabaseKey,
      Authorization: "Bearer " + cfg.supabaseKey,
    };
  }

  function rpc(name, body) {
    return fetch(baseUrl() + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) throw new Error("요청 실패 (" + res.status + ")");
      return res.json();
    });
  }

  /** 후보 가게와 회식 정보. 토큰이 틀리면 null */
  function loadVotePlaces() {
    return fetch(baseUrl() + "/functions/v1/vote-places", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ token: token }),
    }).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("요청 실패 (" + res.status + ")");
      return res.json();
    });
  }

  function storageKey() { return "hoesik-voted-" + token; }
  function alreadyVoted() {
    try { return localStorage.getItem(storageKey()) === "1"; } catch (e) { return false; }
  }
  function markVoted() {
    try { localStorage.setItem(storageKey(), "1"); } catch (e) { /* 사생활 보호 모드 등 */ }
  }

  function renderChips(containerId, items, set) {
    var box = $(containerId);
    items.forEach(function (item) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip avoid";
      b.textContent = item[1];
      b.dataset.key = item[0];
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", function () {
        var on = !set.has(item[0]);
        if (on) set.add(item[0]); else set.delete(item[0]);
        b.setAttribute("aria-pressed", String(on));
      });
      box.appendChild(b);
    });
  }

  /** "음식점 > 한식 > 육류,고기" → "육류,고기" */
  function categoryTail(category) {
    var parts = String(category || "").split(">");
    return parts[parts.length - 1].trim();
  }

  /** 가까우면 도보 몇 분, 1.2km(도보 15분)를 넘으면 km로 (앱 후보 고르기와 같은 기준) */
  function walkText(m) {
    if (typeof m !== "number" || !isFinite(m)) return "";
    if (m > NEAR_LIMIT_M) return "모이는 곳에서 " + (m / 1000).toFixed(1) + "km";
    return "도보 " + Math.max(1, Math.ceil(m / WALK_M_PER_MIN)) + "분";
  }

  /** 카카오맵 링크만 열어요 (다른 주소는 링크로 만들지 않아요). */
  function safeUrl(url) {
    return typeof url === "string" && /^https?:\/\/([a-z0-9-]+\.)*kakao\.com\//i.test(url) ? url : null;
  }

  /** 카카오맵 AI 장소 요약(kanana) 페이지. 내용은 가져오지 않고 링크만 걸어요 (장소 ID만, 앱 place_links.dart 와 같아요). */
  function kananaUrl(id) {
    var m = /^k_(\d+)$/.exec(String(id || ""));
    return m ? "https://kanana.kakao.com/place/p?cid=" + m[1] : null;
  }

  function placeLink(href, text) {
    var link = document.createElement("a");
    link.className = "place-link";
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer external";
    link.textContent = text;
    return link;
  }

  function showError(text) {
    $("error").textContent = text;
    $("error").hidden = !text;
  }

  function renderPlaces(places) {
    var box = $("places");
    box.textContent = "";
    places.forEach(function (p) {
      var card = document.createElement("div");
      card.className = "place";

      var pick = document.createElement("button");
      pick.type = "button";
      pick.className = "place-pick";
      pick.setAttribute("aria-pressed", "false");
      var check = document.createElement("span");
      check.className = "place-check";
      check.setAttribute("aria-hidden", "true");
      var body = document.createElement("span");
      body.className = "place-body";
      var name = document.createElement("span");
      name.className = "place-name";
      name.textContent = p.name;
      var meta = document.createElement("span");
      meta.className = "place-meta";
      meta.textContent = [categoryTail(p.category), walkText(p.distance_m)].filter(Boolean).join(" · ");
      body.appendChild(name);
      body.appendChild(meta);
      pick.appendChild(check);
      pick.appendChild(body);
      pick.addEventListener("click", function () {
        var on = pick.getAttribute("aria-pressed") !== "true";
        if (on && picked().length >= MAX_PICKS) {
          showError("가고 싶은 곳은 " + MAX_PICKS + "곳까지 고르실 수 있습니다.");
          return;
        }
        showError("");
        pick.setAttribute("aria-pressed", String(on));
        card.classList.toggle("on", on);
      });
      pick.dataset.id = p.id;
      card.appendChild(pick);

      var links = document.createElement("div");
      links.className = "place-links";
      var url = safeUrl(p.place_url);
      if (url) links.appendChild(placeLink(url, "카카오맵에서 보기"));
      var summary = demo ? null : kananaUrl(p.id); // 데모 가게는 지어낸 ID라 링크 없음
      if (summary) links.appendChild(placeLink(summary, "카나나 AI 요약"));
      if (links.childNodes.length > 0) card.appendChild(links);
      box.appendChild(card);
    });
  }

  function picked() {
    return Array.prototype.map.call(
      $("places").querySelectorAll('.place-pick[aria-pressed="true"]'),
      function (b) { return b.dataset.id; }
    );
  }

  function formatEvent(info) {
    var d = new Date(info.event_at);
    return (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + WEEKDAYS[d.getDay()] + ") " +
      info.area_name + " 회식";
  }

  function show(id) {
    ["vote-form", "closed", "done"].forEach(function (x) { $(x).hidden = x !== id; });
    if (id === "done") showAd();
  }

  function closed(text) {
    $("closed-text").textContent = text;
    show("closed");
  }

  // AdSense: 투표를 마친 화면에만. 게시자 ID가 없으면 자리만 보여요.
  function showAd() {
    if (!cfg.adsenseClient || !cfg.adsenseSlot || $("ad-slot").dataset.loaded) return;
    $("ad-slot").dataset.loaded = "1";
    var s = document.createElement("script");
    s.async = true;
    s.crossOrigin = "anonymous";
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + encodeURIComponent(cfg.adsenseClient);
    document.head.appendChild(s);
    var ins = document.createElement("ins");
    ins.className = "adsbygoogle";
    ins.style.display = "block";
    ins.setAttribute("data-ad-client", cfg.adsenseClient);
    ins.setAttribute("data-ad-slot", cfg.adsenseSlot);
    ins.setAttribute("data-ad-format", "auto");
    ins.setAttribute("data-full-width-responsive", "true");
    $("ad-slot").appendChild(ins);
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  }

  function submit(ev) {
    ev.preventDefault();
    showError("");
    var ids = picked();
    if (ids.length === 0) {
      showError("가고 싶은 곳을 한 곳 이상 골라 주십시오.");
      return;
    }
    $("submit").disabled = true;
    var body = {
      p_token: token,
      p_place_ids: ids,
      p_allergies: Array.from(state.allergies),
    };
    var done = demo ? Promise.resolve(true) : rpc("submit_place_vote", body);
    done.then(function (ok) {
      if (!ok) return closed(MSG_CLOSED);
      markVoted();
      show("done");
    }).catch(function () {
      $("submit").disabled = false;
      showError("잠시 문제가 생겼습니다. 다시 한번 눌러 주십시오.");
    });
  }

  function ready(info, places) {
    state.places = places;
    renderPlaces(places);
    if (info) {
      $("event-info").textContent = formatEvent(info);
      $("event-info").hidden = false;
    }
    show("vote-form");
  }

  function start() {
    renderChips("allergies", ALLERGIES, state.allergies);
    $("vote-form").addEventListener("submit", submit);

    if (demo) {
      $("demo-banner").hidden = false;
      ready(null, DEMO_PLACES);
      return;
    }
    if (!token) return closed(MSG_INVALID);
    if (alreadyVoted()) return show("done");
    loadVotePlaces().then(function (res) {
      if (!res || !res.event) return closed(MSG_INVALID);
      if (res.event.closed) return closed(MSG_CLOSED);
      var places = Array.isArray(res.places) ? res.places : [];
      if (places.length === 0) return closed("후보 가게를 불러오지 못했습니다. 조금 뒤에 다시 열어 주십시오.");
      ready(res.event, places);
    }).catch(function () {
      closed(MSG_TROUBLE);
    });
  }

  start();
})();
