-- R18版の D1 だけに流す。成年向けの巻の「表紙なし」キャッシュを消し、DLsite（src/dlsite.ts）で
-- 引き直せるようにする。
--
-- R18版はこれまで外部ストアを使っていなかった（src/site.ts commerce: false）ので、表紙の解決は
-- 全件が「表紙なし」（cover_url = ''）で確定してキャッシュされている（covers は永久キャッシュ）。
-- 消さないと DLsite を足しても既に開かれた巻には二度と表紙が付かない。
-- 全年齢の巻の空行は残す（DLsite の成年コミックのフロアには無いので引き直しても空のまま）。
-- 中身のある行（管理者が付けた表紙）は触らない。
--
-- 冪等（何度流しても同じ）。本家の D1 に流しても成年向けの巻が無いので 0 件。
DELETE FROM covers
 WHERE cover_url = ''
   AND isbn IN (SELECT isbn FROM volumes WHERE is_adult = 1);
