// This catalog also defines the values accepted by the classroom API.
export const avatarOptions = {
  hairStyle: [["classic", "標準"], ["crop", "ショート"], ["swept", "流し前髪"],
    ["bob", "ボブ"], ["pony", "ポニーテール"], ["buns", "おだんご"], ["spikes", "立ち上げ"], ["curls", "カール"]],
  face: [["classic", "標準"], ["smile", "にっこり"], ["gentle", "おだやか"],
    ["confident", "きりっと"], ["bright", "ぱっちり"], ["freckles", "そばかす"]],
  outfit: [["classic", "標準"], ["hoodie", "パーカー"], ["jacket", "ジャケット"], ["overalls", "オーバーオール"],
    ["apron", "エプロン"], ["uniform", "制服"], ["sport", "スポーツウェア"], ["pilot", "フライトスーツ"]],
  accessory: [["none", "なし"], ["glasses", "メガネ"], ["cap", "キャップ"], ["beanie", "ニット帽"],
    ["helmet", "作業ヘルメット"], ["headphones", "ヘッドホン"]],
  skinTone: [["auto", "標準"], ["ivory", "アイボリー", 0xf0ceb1], ["sand", "サンド", 0xdfaa7c],
    ["honey", "ハニー", 0xc18a5b], ["bronze", "ブロンズ", 0x9c644d], ["umber", "アンバー", 0x704b3b]],
  hairColor: [["auto", "標準"], ["ink", "黒", 0x232c38], ["earth", "こげ茶", 0x48342c],
    ["chestnut", "栗色", 0x864c31], ["gold", "金色", 0xbc8647], ["silver", "銀色", 0xa9b5c9],
    ["rose", "赤紫", 0x9c4864], ["ocean", "深青", 0x296474], ["violet", "すみれ", 0x654685]],
};
export const avatarDesignFields = Object.keys(avatarOptions);
export const defaultAvatarDesign = Object.freeze(Object.fromEntries(
  avatarDesignFields.map(field => [field, avatarOptions[field][0][0]])));

export function avatarDesign(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== avatarDesignFields.length) return null;
  if (!avatarDesignFields.every(field => Object.hasOwn(value, field) &&
      avatarOptions[field].some(([id]) => id === value[field]))) return null;
  return Object.fromEntries(avatarDesignFields.map(field => [field, value[field]]));
}

export const avatarPresets = [
  ["街の探検家", "crop", "smile", "jacket", "beanie", "honey", "earth", "#4d754f"],
  ["駅員さん", "swept", "gentle", "uniform", "cap", "sand", "ink", "#263d5c"],
  ["放課後", "curls", "bright", "hoodie", "headphones", "ivory", "violet", "#6955a4"],
  ["まちの設計士", "bob", "confident", "overalls", "helmet", "bronze", "ink", "#416b83"],
  ["喫茶店", "buns", "freckles", "apron", "glasses", "sand", "chestnut", "#a34e46"],
  ["自転車日和", "pony", "smile", "sport", "none", "ivory", "chestnut", "#357d8c"],
  ["森の案内人", "bob", "gentle", "jacket", "beanie", "bronze", "gold", "#729359"],
  ["ストリート", "spikes", "confident", "jacket", "none", "honey", "ocean", "#34394d"],
  ["スポーツ選手", "crop", "bright", "sport", "cap", "umber", "ink", "#c75a38"],
  ["空のパイロット", "swept", "smile", "pilot", "headphones", "sand", "silver", "#3b729b"],
  ["アトリエ", "bob", "freckles", "apron", "none", "ivory", "rose", "#328472"],
  ["星の観測員", "curls", "gentle", "hoodie", "glasses", "umber", "silver", "#48527c"],
].map(([name, hairStyle, face, outfit, accessory, skinTone, hairColor, color]) => ({
  name, color, design: { hairStyle, face, outfit, accessory, skinTone, hairColor },
}));
