-- 発行部数ランキングの寄せ先の指定（scripts/dump-circulation-links.mjs で生成。手で編集しない）。
-- 生成: 2026-10-03T17:54:34.649Z  199 件（manual 3 / suggested 196）
-- リストア: npx wrangler d1 execute DB --remote --file db/circulation-links.sql
-- 前提: db/add-circulation.sql・db/add-circulation-link.sql 適用済み。upsert なので何度流しても安全。
-- 流したあとに管理画面「発行部数ランキング」の再集計を実行する（寄せ先と表紙を付け直す）。

-- 20世紀少年 → 20世紀少年
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('20th Century Boys', 'C286658', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 3×3 EYES → 3×3EYES
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('3×3 Eyes', 'C299861', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 750ライダー → 750ライダー
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('750 Rider', 'C276399', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- とある魔術の禁書目録 → とある魔術の禁書目録
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('A Certain Magical Index', 'C320639', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- あぶさん → あぶさん
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Abu-san', 'C313738', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ダイヤのA → ダイヤのA
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Ace of Diamond', 'C261065', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- あひるの空 → あひるの空
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Ahiru no Sora', 'C298412', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- エンジェル・ハート → エンジェル・ハート
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Angel Heart (manga)', 'C301627', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- アオアシ → アオアシ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Aoashi', 'C353423', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- あさりちゃん → あさりちゃん
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Asari-chan', 'C264322', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- あしたのジョー → あしたのジョー
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Ashita no Joe', 'C294317', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 暗殺教室 → 暗殺教室
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Assassination Classroom', 'C332351', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 鉄腕アトム → 鉄腕アトム
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Astro Boy', 'C291550', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 進撃の巨人 → 進撃の巨人
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Attack on Titan', 'C274933', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- BADBOYS → BAD BOYS
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Bad Boys (manga)', 'C323425', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- グラップラー刃牙 → グラップラー刃牙
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Baki the Grappler', 'C326247', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- バリバリ伝説 → バリバリ伝説
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Bari Bari Densetsu', 'C314171', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- BASTARD!! → BASTARD!!
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Bastard!!', 'C254201', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ビー・バップ・ハイスクール → Be-bop-highschool（手動）
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Be-Bop High School', 'C298271', 'manual', 1791050066291)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ベルセルク → ベルセルク
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Berserk (manga)', 'C254353', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 黒執事 → 黒執事
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Black Butler', 'C326644', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ブラッククローバー → ブラッククローバー
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Black Clover', 'C355139', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ブラック・ジャック → ブラック・ジャック
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Black Jack (manga)', 'C276748', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- BLEACH → BLEACH
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Bleach (manga)', 'C264507', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 青の祓魔師 → 青の祓魔師
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Blue Exorcist', 'C260515', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ブルーロック → ブルーロック = BLUELOCK
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Blue Lock', 'C419788', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- BOYS BE… → BOYS BE…
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Boys Be...', 'C292099', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 花より男子 → 花より男子
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Boys Over Flowers', 'C318403', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ブッダ → ブッダ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Buddha (manga)', 'C284370', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- キャプテン翼 → キャプテン翼
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Captain Tsubasa', 'C259671', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- カードキャプターさくら → カードキャプターさくら
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Cardcaptor Sakura', 'C277425', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 名探偵コナン → 名探偵コナン
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Case Closed', 'C254432', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- キャッツ・アイ → キャッツ・アイ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Cat''s Eye (manga)', 'C304924', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- チェンソーマン → チェンソーマン = Chain saw man
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Chainsaw Man', 'C418063', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- カメレオン → カメレオン
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Chameleon (manga)', 'C278760', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ちびまる子ちゃん → ちびまる子ちゃん
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Chibi Maruko-chan', 'C257102', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ちはやふる → ちはやふる
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Chihayafuru', 'C325143', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- シティーハンター → シティーハンター
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('City Hunter', 'C301673', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- コブラ → コブラ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Cobra (manga)', 'C261464', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- クッキングパパ → クッキングパパ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Cooking Papa', 'C260921', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- クレヨンしんちゃん → クレヨンしんちゃん
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Crayon Shin-chan', 'C270877', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 王家の紋章 → 王家の紋章
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Crest of the Royal Family', 'C261390', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- クローズ → クローズ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Crows (manga)', 'C298649', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- CUFFS → CUFFS
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Cuffs – Kizu Darake no Chizu', 'C303729', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- D.Gray-man → D.Gray-man
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('D.Gray-man', 'C308964', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- DEAR BOYS → Dear boys
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Dear Boys', 'C320908', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- DEATH NOTE → DEATH NOTE
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Death Note', 'C310756', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 鬼滅の刃 → 鬼滅の刃
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Demon Slayer: Kimetsu no Yaiba', 'C361806', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- デビルマン → デビルマン
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Devilman', 'C288181', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ドカベン → ドカベン
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Dokaben', 'C323334', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ミステリと言う勿れ → ミステリと言う勿れ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Don''t Call It Mystery', 'C420321', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ドラえもん → ドラえもん
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Doraemon', 'C300052', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- Dr.スランプ → Dr.スランプ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Dr. Slump', 'C297795', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- Dr.STONE → Dr.STONE
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Dr. Stone', 'C369101', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ドラゴンボール → ドラゴンボール
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Dragon Ball (manga)', 'C257176', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ロトの紋章 → ロトの紋章
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Dragon Quest Retsuden: Roto no Monshō', 'C299597', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ドラゴンクエスト ダイの大冒険 → ドラゴンクエスト ダイの大冒険
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Dragon Quest: The Adventure of Dai', 'C285832', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 動物のお医者さん → 動物のお医者さん
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Dōbutsu no Oisha-san', 'C262210', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 代紋TAKE2 → 代紋TAKE2
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Emblem Take 2', 'C324244', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- アイシールド21 → アイシールド21
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Eyeshield 21', 'C309596', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- FAIRY TAIL → FAIRY TAIL
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Fairy Tail', 'C267479', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 炎炎ノ消防隊 → 炎炎ノ消防隊
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Fire Force', 'C360222', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 釣りキチ三平 → 釣りキチ三平
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Fisherman Sanpei', 'C328197', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 北斗の拳 → 北斗の拳
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Fist of the North Star', 'C254499', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 烈火の炎 → 烈火の炎
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Flame of Recca', 'C271026', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 食戟のソーマ → 食戟のソーマ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Food Wars!: Shokugeki no Soma', 'C332385', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 葬送のフリーレン → 葬送のフリーレン = FRIEREN
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Frieren', 'C437653', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- フルーツバスケット → フルーツバスケット
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Fruits Basket', 'C254340', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 鋼の錬金術師 → 鋼の錬金術師
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Fullmetal Alchemist', 'C259501', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ふしぎ遊戯 → ふしぎ遊戯
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Fushigi Yûgi', 'C312979', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ふたりエッチ → ふたりエッチ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Futari Ecchi', 'C293789', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- がきデカ → がきデカ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Gaki Deka', 'C311430', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- GANTZ → GANTZ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Gantz', 'C293896', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- GIANT KILLING → Giant killing
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Giant Killing', 'C267873', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 銀魂 → 銀魂
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Gintama', 'C277533', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ガラスの仮面 → ガラスの仮面
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Glass Mask', 'C322446', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ゴールデンカムイ → ゴールデンカムイ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Golden Kamuy', 'C355112', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ゴルゴ13 → ゴルゴ13
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Golgo 13', 'C258823', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- GTO → GTO
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Great Teacher Onizuka', 'C322586', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- H2 → H2
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('H2 (manga)', 'C254076', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ハイキュー!! → ハイキュー!!
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Haikyu!!', 'C332134', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- はじめの一歩 → はじめの一歩
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Hajime no Ippo', 'C288046', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ハヤテのごとく! → ハヤテのごとく!
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Hayate the Combat Butler', 'C329760', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 地獄先生ぬ〜べ〜 → 地獄先生ぬ～べ～
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Hell Teacher: Jigoku Sensei Nube', 'C263216', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ヒカルの碁 → ヒカルの碁
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Hikaru no Go', 'C310739', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ひみつシリーズ → 学研まんがひみつシリーズ新訂版（手動）
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Himitsu Series', 'C316295', 'manual', 1791050066513)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 封神演義 → 封神演義
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Hoshin Engi', 'C273130', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- HUNTER×HUNTER → Hunter×hunter
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Hunter × Hunter', 'C313295', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 頭文字D → 頭文字D
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Initial D', 'C334599', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 犬夜叉 → 犬夜叉
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Inuyasha', 'C263482', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- イタズラなKiss → イタズラなkiss
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Itazura na Kiss', 'C293494', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- じゃりン子チエ → じゃりン子チエ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Jarinko Chie', 'C281302', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 仁義 → 仁義
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Jingi (manga)', 'C323007', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ジョジョの奇妙な冒険 → ジョジョの奇妙な冒険
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('JoJo''s Bizarre Adventure', 'C277363', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 呪術廻戦 → 呪術廻戦
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Jujutsu Kaisen', 'C419016', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- かぐや様は告らせたい → かぐや様は告らせたい
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Kaguya-sama: Love Is War', 'C361747', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 賭博黙示録カイジ → 賭博黙示録カイジ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Kaiji (manga)', 'C312634', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 疾風伝説 特攻の拓 → 疾風伝説特攻の拓
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Kaze Densetsu: Bukkomi no Taku', 'C303145', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 花の慶次 → 花の慶次
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Keiji (manga)', 'C293854', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- きまぐれオレンジ☆ロード → きまぐれオレンジ☆ロード
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Kimagure Orange Road', 'C316266', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 君に届け → 君に届け
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Kimi ni Todoke', 'C309315', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- キングダム → キングダム
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Kingdom (manga)', 'C328317', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- キン肉マン → キン肉マン
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Kinnikuman', 'C261524', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- こちら葛飾区亀有公園前派出所 → こちら葛飾区亀有公園前派出所
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('KochiKame: Tokyo Beat Cops', 'C295645', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 課長島耕作 → 課長島耕作
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Kosaku Shima', 'C256602', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 黒子のバスケ → 黒子のバスケ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Kuroko''s Basketball', 'C284468', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 今日から俺は!! → 今日から俺は!!
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Kyō Kara Ore Wa!!', 'C292751', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ラブひな → ラブひな
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Love Hina', 'C279436', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- メイドインアビス → メイドインアビス
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Made in Abyss', 'C337059', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- マギ → マギ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Magi: The Labyrinth of Magic', 'C291558', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- めぞん一刻 → めぞん一刻
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Maison Ikkoku', 'C286510', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- MAJOR → MAJOR
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Major (manga)', 'C282937', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- MASTERキートン → Masterキートン
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Master Keaton', 'C286758', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- マジンガーZ → マジンガーZ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Mazinger Z', 'C327059', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ミナミの帝王 → ミナミの帝王
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Minami no Teiō', 'C276927', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- みゆき → みゆき
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Miyuki (manga)', 'C254266', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- MONSTER → MONSTER
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Monster (manga)', 'C286532', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 僕のヒーローアカデミア → 僕のヒーローアカデミア
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('My Hero Academia', 'C347796', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- NANA → NANA
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Nana (manga)', 'C285901', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- NARUTO → NARUTO
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Naruto', 'C295029', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 魔法先生ネギま! → 魔法先生ネギま!
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Negima! Magister Negi Magi', 'C279546', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 新世紀エヴァンゲリオン → 新世紀エヴァンゲリオン
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Neon Genesis Evangelion (manga)', 'C284666', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- のだめカンタービレ → のだめカンタービレ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Nodame Cantabile', 'C257949', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ああっ女神さまっ → ああっ女神さまっ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Oh My Goddess!', 'C276393', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 美味しんぼ → 美味しんぼ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Oishinbo', 'C259867', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ONE PIECE → ONE PIECE
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('One Piece', 'C268196', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ワンパンマン → ワンパンマン
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('One-Punch Man', 'C332823', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 推しの子 → 推しの子
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Oshi no Ko', 'C437145', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 押忍!!空手部 → 押忍!!空手部
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Osu! Karate Club', 'C322606', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 寄生獣 → 寄生獣
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Parasyte', 'C269618', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- パタリロ! → パタリロ!
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Patalliro!', 'C259719', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 孔雀王 → 孔雀王
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Peacock King', 'C326213', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ポケットモンスターSPECIAL → ポケットモンスターspecial
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Pokémon Adventures', 'C323120', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- らんま1/2 → らんま1/2
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Ranma ½', 'C286503', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- RAVE → Rave
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Rave Master', 'C324453', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 家庭教師ヒットマンREBORN! → 家庭教師ヒットマンREBORN!
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Reborn!', 'C310466', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 終末のワルキューレ → 終末のワルキューレ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Record of Ragnarok', 'C419261', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 天は赤い河のほとり → 天は赤い河のほとり
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Red River (manga)', 'C321281', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ろくでなしBLUES → ろくでなしBLUES
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Rokudenashi Blues', 'C317113', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ROOKIES → Rookies
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Rookies (manga)', 'C330682', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- るろうに剣心 → るろうに剣心
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Rurouni Kenshin', 'C303993', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 美少女戦士セーラームーン → 美少女戦士セーラームーン
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Sailor Moon', 'C293114', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 聖闘士星矢 → 聖闘士星矢
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Saint Seiya', 'C265065', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 最遊記 → 最遊記
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Saiyuki (manga)', 'C323979', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 魁!!男塾 → 魁!!男塾
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Sakigake!! Otokojuku', 'C306508', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- サラリーマン金太郎 → サラリーマン金太郎
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Salary Man Kintaro', 'C319198', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 三国志 → 三国志
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Sangokushi (manga)', 'C276797', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- サザエさん → サザエさん
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Sazae-san', 'C435224', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 生徒諸君! → 生徒諸君!
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Seito Shokun!', 'C283970', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- シャーマンキング → シャーマンキング
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Shaman King', 'C274828', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 静かなるドン → 静かなるドン
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Shizukanaru Don – Yakuza Side Story', 'C280103', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 湘南爆走族 → 湘南爆走族
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Shonan Bakusozoku', 'C293131', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 湘南純愛組! → 湘南純愛組!
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Shonan Junai Gumi', 'C273951', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- シュート! → シュート!
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Shoot! (manga)', 'C287770', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 修羅の門 → 修羅の門
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Shura no Mon', 'C269693', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 少年アシベ → 少年アシベ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Shōnen Ashibe', 'C320922', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 少年少女日本の歴史 → 少年少女日本の歴史
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Shōnen Shōjo Nippon no Rekishi', 'C277529', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- SLAM DUNK → Slam dunk
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Slam Dunk (manga)', 'C262538', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ソウルイーター → SOUL EATER（手動）
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Soul Eater', 'C310549', 'manual', 1791050065756)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 宇宙兄弟 → 宇宙兄弟
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Space Brothers (manga)', 'C262917', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- SPY×FAMILY → SPY×FAMILY
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Spy × Family', 'C432817', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- スケバン刑事 → スケバン刑事
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Sukeban Deka', 'C303631', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 浦安鉄筋家族 → 浦安鉄筋家族
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Super Radical Gag Family', 'C322585', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- SWAN → SWAN
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Swan (manga)', 'C327453', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 黄昏流星群 → 黄昏流星群
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Tasogare Ryūseigun', 'C256161', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- テラフォーマーズ → テラフォーマーズ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Terra Formars', 'C333354', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 転生したらスライムだった件 → 転生したらスライムだった件
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('That Time I Got Reincarnated as a Slime', 'C357983', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 薬屋のひとりごと → 薬屋のひとりごと
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('The Apothecary Diaries', 'C422216', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ザ・シェフ → ザ・シェフ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('The Chef (manga)', 'C260643', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ザ・ファブル → ザ・ファブル
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('The Fable', 'C355344', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 金田一少年の事件簿 → 金田一少年の事件簿
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('The Kindaichi Case Files', 'C311653', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 行け!稲中卓球部 → 行け!稲中卓球部
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('The Ping Pong Club', 'C311918', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- テニスの王子様 → テニスの王子様
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('The Prince of Tennis', 'C258734', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 約束のネバーランド → 約束のネバーランド
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('The Promised Neverland', 'C366694', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 五等分の花嫁 → 五等分の花嫁
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('The Quintessential Quintuplets', 'C370043', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ベルサイユのばら → ベルサイユのばら
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('The Rose of Versailles', 'C303342', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 七つの大罪 → 七つの大罪
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('The Seven Deadly Sins (manga)', 'C332469', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 沈黙の艦隊 → 沈黙の艦隊
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('The Silent Service', 'C258852', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ときめきトゥナイト → ときめきトゥナイト
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Tokimeki Tonight', 'C274806', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 東京大学物語 → 東京大学物語
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Tokyo Daigaku Monogatari', 'C293878', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 東京喰種 → 東京喰種
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Tokyo Ghoul', 'C335342', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 東京卍リベンジャーズ → 東京卍リベンジャーズ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Tokyo Revengers', 'C368624', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- トリコ → トリコ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Toriko', 'C267537', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- タッチ → タッチ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Touch (manga)', 'C258597', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- ツバサ → ツバサ
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Tsubasa: Reservoir Chronicle', 'C299002', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 釣りバカ日誌 → 釣りバカ日誌
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Tsuribaka Nisshi', 'C275554', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- うる星やつら → うる星やつら
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Urusei Yatsura', 'C258774', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 闇金ウシジマくん → 闇金ウシジマくん
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Ushijima the Loan Shark', 'C270932', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- うしおととら → うしおととら
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Ushio and Tora', 'C274661', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- バガボンド → バガボンド
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Vagabond (manga)', 'C262153', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 銀牙伝説WEED → 銀牙伝説Weed
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Weed (manga)', 'C258931', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 魔入りました!入間くん → 魔入りました!入間くん
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Welcome to Demon School! Iruma-kun', 'C369836', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- WORST → WORST
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Worst (manga)', 'C298307', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- YAWARA! → YAWARA!
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Yawara!', 'C286273', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 弱虫ペダル → 弱虫ペダル
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Yowamushi Pedal', 'C314012', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 遊・戯・王 → 遊・戯・王
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Yu-Gi-Oh!', 'C258183', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 幽☆遊☆白書 → 幽☆遊☆白書
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('YuYu Hakusho', 'C307180', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 有閑倶楽部 → 有閑倶楽部
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Yūkan Club', 'C254246', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';
-- 金色のガッシュ!! → 金色のガッシュ!!
INSERT INTO circulation_link (article, series_id, source, created_at) VALUES ('Zatch Bell!', 'C284334', 'suggested', 1791049624733)
  ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = excluded.source, created_at = excluded.created_at
  WHERE circulation_link.source <> 'manual' OR excluded.source = 'manual';

-- 集計を作り直させる（管理画面の再集計を忘れても、次のアクセスで作り直される）。
DELETE FROM meta WHERE key = 'circulation_ranking_json';
