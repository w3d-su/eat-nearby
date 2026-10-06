# 附近吃什麼 — 規格書

純前端單頁應用:瀏覽器自動定位後,用 OpenStreetMap Overpass API 撈附近餐廳,顯示可篩選的清單與 Leaflet 地圖,並提供拉霸式「幫我決定」隨機抽籤,附最愛/黑名單/不重複功能。

## 1. 技術決策

- 純 HTML/CSS/JS,無建置工具;傳統 `<script>` 標籤(非 ES modules),`file://` 雙擊可開
- 資料來源:OpenStreetMap Overpass API(免費、免 API key)
- 定位:瀏覽器 Geolocation API
- 地圖:Leaflet + OSM 圖磚
- 介面語言:繁體中文

**已知限制**:OSM 沒有評分、價位、照片;`cuisine`/`opening_hours` 標籤覆蓋率不完整 → 不做評分/價位功能,缺標籤的店照常顯示。

## 2. 檔案結構

```
index.html   # 單一檔案:HTML 結構 + <style> 全部樣式 + 兩個 <script>(常數/工具 + 主邏輯)
SPEC.md      # 本規格書
```

> 原本是 4 檔分離(index/style/data/app),後整理為單一 index.html 方便傳遞部署。
> 內部仍分兩個 script 區塊:第一塊是對照表/查詢產生器/storage helpers,第二塊是主邏輯 IIFE。

## 3. 功能需求

### 3.1 定位
- 進入頁面呼叫 `navigator.geolocation.getCurrentPosition`,顯示「定位中…」
- 成功:以此位置查詢餐廳
- 失敗/拒絕:錯誤訊息 + 點擊定位狀態重試 + 地圖點擊手動選位置(降級方案)

### 3.2 餐廳資料查詢(Overpass API)
- Endpoints 依序嘗試:`overpass-api.de` → `lz4.overpass-api.de` → `z.overpass-api.de` → `overpass.kumi.systems` → `overpass.private.coffee`;POST `data=`
- 查詢(半徑 R 公尺):
  ```
  [out:json][timeout:25];
  (
    nwr["amenity"~"^(restaurant|fast_food|cafe|food_court|bar|pub|ice_cream)$"](around:R,LAT,LNG);
    nwr["shop"~"^(tea|bakery|confectionery|dessert)$"](around:R,LAT,LNG);
  );
  out center tags;
  ```
- 只保留有 `name` 的項目;`way`/`relation` 用 `center` 座標
- 過濾黑名單、計算與使用者距離(haversine)

### 3.2.1 Nominatim 備援
- 若所有 Overpass endpoint 失敗 → 改用 `nominatim.openstreetmap.org/search`(viewbox 依半徑換算,`bounded=1&extratags=1&namedetails=1&limit=50`)
- 依序查 `restaurant` / `fast food` / `cafe` / `tea`,每 request 間隔 ≥1.1s(usage policy 1 req/s),osm id 去重
- `extratags` 提供 `cuisine`/`opening_hours` 等標籤 → 沿用同一套解析
- 備援結果無 `addr:*` 地址;清單標註「(備援資料)」

### 3.3 篩選條件

| 篩選 | UI | 說明 |
|---|---|---|
| 距離範圍 | 按鈕組 500m/1km/2km/3km | 改變時重新查詢 |
| 餐廳類型 | checkbox 群組 | 餐廳/速食/咖啡廳飲料/美食街/酒吧/冰品甜點(本地過濾) |
| 料理類型 | 下拉選單 | 從結果實際出現的 `cuisine` 動態產生 |
| 只看營業中 | toggle | 可解析為打烊→隱藏;未標註保留並顯示「營業時間未提供」 |
| 只看最愛 | toggle | 只顯示收藏名單內的店 |

### 3.4 餐廳清單
- 卡片:店名、類型中文標籤、料理類型、距離、營業狀態、地址(若有 `addr:*`)、Google 地圖連結
- 操作:♥ 收藏、✕ 加入黑名單
- 點卡片 → 地圖 pan 到 marker 開 popup
- 排序:距離近→遠
- 黑名單區:底部「已隱藏 N 間」可展開復原

### 3.5 Leaflet 地圖
- `tile.openstreetmap.org` 圖磚 + attribution
- 使用者位置:藍點 + `L.circle` 顯示目前半徑
- 餐廳:circleMarker,點擊開 popup
- 抽中結果時地圖 zoom 到該店

### 3.6 隨機抽(拉霸)
- 「幫我決定!」固定於畫面底部
- 全屏 overlay:店名高速輪播後減速定格(約 2.5 秒)
- 抽籤池 = 篩選結果 − 黑名單 − 最近抽過
- 結果卡:店名、類型、距離、營業狀態、Google 地圖連結、「再抽一次」、「就這間!」
- 抽到不重複:localStorage 記最近 10 筆;池中全被排除→清空重抽名單

### 3.7 Google 地圖連結
`https://www.google.com/maps/search/?api=1&query=LAT,LNG`

### 3.8 localStorage

| key | 內容 |
|---|---|
| `eat-favorites` | `[osmId, ...]` |
| `eat-blacklist` | `[{id, name}, ...]` |
| `eat-recent-picks` | `[osmId, ...]` cap 10 |
| `eat-filters` | 上次篩選條件(距離/類型/只看營業中) |

## 4. UI/UX

- mobile-first 單欄;桌面寬螢幕左清單右地圖
- 頂部 bar:標題 + 定位狀態(可點擊重試)+ 篩選展開鈕
- 篩選面板可收合;地圖約 40vh;下方卡片清單;底部固定抽籤鈕
- 狀態:loading / 錯誤 / 空結果提示

## 5. 中文對照表

見 `data.js`:`CATEGORY_DEFS`(amenity/shop → 分類中文)與 `CUISINE_ZH`(cuisine → 中文,未列出顯示原值)。

## 6. 外部 CDN 依賴

| 套件 | URL | 用途 |
|---|---|---|
| Leaflet 1.9.4 | unpkg | 地圖 |
| SunCalc 1.9.0 | jsDelivr | opening_hours 依賴 |
| opening_hours 3.14.0(`build/opening_hours.js`) | jsDelivr | 解析營業時間 |

opening_hours 載失或單筆解析失敗 → 該店視為「未提供」,不影響其他功能。

## 7. 錯誤處理

- 定位拒絕/逾時 → 提示 + 重試 + 地圖點選手動設位置
- Overpass 逾時/429/5xx → 換 mirror 重試,仍失敗顯示錯誤可重試
- 查無結果 → 提示放大半徑或放寬篩選
- `opening_hours` 解析例外 → try/catch 視為未提供
- 抽籤池空 → 提示放寬條件

## 8. Out of Scope

評分/評論/價位/照片、後端、帳號同步、多國語言、離線使用(地圖圖磚需外網)。

## 9. 驗證方式

`python3 -m http.server 8000` → 開 `localhost:8000`:定位→清單→改半徑重查→篩選→抽籤→收藏/黑名單重新整理後保留→Google 連結可開。
