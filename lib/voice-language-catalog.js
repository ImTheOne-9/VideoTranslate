'use strict';

// [female, male]. This catalog is shared by Edge fallback and OmniVoice routing
// so every translated target keeps a voice in the correct language.
const EDGE_LANGUAGE_VOICES = Object.freeze({
  af: ['af-ZA-AdriNeural', 'af-ZA-WillemNeural'], sq: ['sq-AL-AnilaNeural', 'sq-AL-IlirNeural'],
  am: ['am-ET-MekdesNeural', 'am-ET-AmehaNeural'], az: ['az-AZ-BanuNeural', 'az-AZ-BabekNeural'],
  pl: ['pl-PL-ZofiaNeural', 'pl-PL-MarekNeural'], fa: ['fa-IR-DilaraNeural', 'fa-IR-FaridNeural'],
  bn: ['bn-IN-TanishaaNeural', 'bn-IN-BashkarNeural'], bs: ['bs-BA-VesnaNeural', 'bs-BA-GoranNeural'],
  bg: ['bg-BG-KalinaNeural', 'bg-BG-BorislavNeural'], pt: ['pt-BR-ThalitaMultilingualNeural', 'pt-BR-AntonioNeural'],
  ca: ['ca-ES-JoanaNeural', 'ca-ES-EnricNeural'], hr: ['hr-HR-GabrijelaNeural', 'hr-HR-SreckoNeural'],
  he: ['he-IL-HilaNeural', 'he-IL-AvriNeural'], en: ['en-US-EmmaNeural', 'en-US-AndrewNeural'],
  et: ['et-EE-AnuNeural', 'et-EE-KertNeural'], gl: ['gl-ES-SabelaNeural', 'gl-ES-RoiNeural'],
  ka: ['ka-GE-EkaNeural', 'ka-GE-GiorgiNeural'], gu: ['gu-IN-DhwaniNeural', 'gu-IN-NiranjanNeural'],
  hi: ['hi-IN-SwaraNeural', 'hi-IN-MadhurNeural'], hu: ['hu-HU-NoemiNeural', 'hu-HU-TamasNeural'],
  el: ['el-GR-AthinaNeural', 'el-GR-NestorasNeural'], nl: ['nl-NL-ColetteNeural', 'nl-NL-MaartenNeural'],
  ko: ['ko-KR-SunHiNeural', 'ko-KR-HyunsuMultilingualNeural'], is: ['is-IS-GudrunNeural', 'is-IS-GunnarNeural'],
  id: ['id-ID-GadisNeural', 'id-ID-ArdiNeural'], ga: ['ga-IE-OrlaNeural', 'ga-IE-ColmNeural'],
  jv: ['jv-ID-SitiNeural', 'jv-ID-DimasNeural'], kn: ['kn-IN-SapnaNeural', 'kn-IN-GaganNeural'],
  kk: ['kk-KZ-AigulNeural', 'kk-KZ-DauletNeural'], km: ['km-KH-SreymomNeural', 'km-KH-PisethNeural'],
  lv: ['lv-LV-EveritaNeural', 'lv-LV-NilsNeural'], lt: ['lt-LT-OnaNeural', 'lt-LT-LeonasNeural'],
  lo: ['lo-LA-KeomanyNeural', 'lo-LA-ChanthavongNeural'], mk: ['mk-MK-MarijaNeural', 'mk-MK-AleksandarNeural'],
  ml: ['ml-IN-SobhanaNeural', 'ml-IN-MidhunNeural'], ms: ['ms-MY-YasminNeural', 'ms-MY-OsmanNeural'],
  mt: ['mt-MT-GraceNeural', 'mt-MT-JosephNeural'], mr: ['mr-IN-AarohiNeural', 'mr-IN-ManoharNeural'],
  my: ['my-MM-NilarNeural', 'my-MM-ThihaNeural'], mn: ['mn-MN-YesuiNeural', 'mn-MN-BataaNeural'],
  nb: ['nb-NO-PernilleNeural', 'nb-NO-FinnNeural'], ne: ['ne-NP-HemkalaNeural', 'ne-NP-SagarNeural'],
  ru: ['ru-RU-SvetlanaNeural', 'ru-RU-DmitryNeural'], ja: ['ja-JP-NanamiNeural', 'ja-JP-KeitaNeural'],
  ps: ['ps-AF-LatifaNeural', 'ps-AF-GulNawazNeural'], fil: ['fil-PH-BlessicaNeural', 'fil-PH-AngeloNeural'],
  fr: ['fr-FR-VivienneMultilingualNeural', 'fr-FR-RemyMultilingualNeural'], fi: ['fi-FI-NooraNeural', 'fi-FI-HarriNeural'],
  ro: ['ro-RO-AlinaNeural', 'ro-RO-EmilNeural'], sr: ['sr-RS-SophieNeural', 'sr-RS-NicholasNeural'],
  si: ['si-LK-ThiliniNeural', 'si-LK-SameeraNeural'], sk: ['sk-SK-ViktoriaNeural', 'sk-SK-LukasNeural'],
  sl: ['sl-SI-PetraNeural', 'sl-SI-RokNeural'], so: ['so-SO-UbaxNeural', 'so-SO-MuuseNeural'],
  su: ['su-ID-TutiNeural', 'su-ID-JajangNeural'], sw: ['sw-KE-ZuriNeural', 'sw-KE-RafikiNeural'],
  cs: ['cs-CZ-VlastaNeural', 'cs-CZ-AntoninNeural'], ta: ['ta-IN-PallaviNeural', 'ta-IN-ValluvarNeural'],
  te: ['te-IN-ShrutiNeural', 'te-IN-MohanNeural'], th: ['th-TH-PremwadeeNeural', 'th-TH-NiwatNeural'],
  tr: ['tr-TR-EmelNeural', 'tr-TR-AhmetNeural'], sv: ['sv-SE-SofieNeural', 'sv-SE-MattiasNeural'],
  zh: ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunjianNeural'], es: ['es-ES-XimenaNeural', 'es-ES-AlvaroNeural'],
  uk: ['uk-UA-PolinaNeural', 'uk-UA-OstapNeural'], ur: ['ur-PK-UzmaNeural', 'ur-PK-AsadNeural'],
  uz: ['uz-UZ-MadinaNeural', 'uz-UZ-SardorNeural'], vi: ['vi-VN-HoaiMyNeural', 'vi-VN-NamMinhNeural'],
  cy: ['cy-GB-NiaNeural', 'cy-GB-AledNeural'], zu: ['zu-ZA-ThandoNeural', 'zu-ZA-ThembaNeural'],
  it: ['it-IT-ElsaNeural', 'it-IT-GiuseppeMultilingualNeural'], da: ['da-DK-ChristelNeural', 'da-DK-JeppeNeural'],
  de: ['de-DE-SeraphinaMultilingualNeural', 'de-DE-FlorianMultilingualNeural'],
  ar: ['ar-EG-SalmaNeural', 'ar-EG-ShakirNeural']
});

// One source of truth for the output-language dropdown and translation prompts.
// `google` keeps the provider-specific aliases used by the legacy translator.
const OUTPUT_LANGUAGE_METADATA = Object.freeze({
  af: ['Afrikaans', 'Afrikaans', 'af'], sq: ['Albania', 'Albanian', 'sq'],
  am: ['Amharic', 'Amharic', 'am'], az: ['Azerbaijan', 'Azerbaijani', 'az'],
  pl: ['Ba Lan', 'Polish', 'pl'], fa: ['Ba Tư', 'Persian', 'fa'],
  bn: ['Bengal', 'Bengali', 'bn'], bs: ['Bosnia', 'Bosnian', 'bs'],
  bg: ['Bulgaria', 'Bulgarian', 'bg'], pt: ['Bồ Đào Nha', 'Portuguese', 'pt'],
  ca: ['Catalan', 'Catalan', 'ca'], hr: ['Croatia', 'Croatian', 'hr'],
  he: ['Do Thái', 'Hebrew', 'iw'], en: ['English', 'English', 'en'],
  et: ['Estonia', 'Estonian', 'et'], gl: ['Galicia', 'Galician', 'gl'],
  ka: ['Georgia', 'Georgian', 'ka'], gu: ['Gujarat', 'Gujarati', 'gu'],
  hi: ['Hindi', 'Hindi', 'hi'], hu: ['Hungary', 'Hungarian', 'hu'],
  el: ['Hy Lạp', 'Greek', 'el'], nl: ['Hà Lan', 'Dutch', 'nl'],
  ko: ['Hàn Quốc', 'Korean', 'ko'], is: ['Iceland', 'Icelandic', 'is'],
  id: ['Indonesia', 'Indonesian', 'id'], ga: ['Ireland', 'Irish', 'ga'],
  jv: ['Java', 'Javanese', 'jw'], kn: ['Kannada', 'Kannada', 'kn'],
  kk: ['Kazakhstan', 'Kazakh', 'kk'], km: ['Khmer', 'Khmer', 'km'],
  lv: ['Latvia', 'Latvian', 'lv'], lt: ['Litva', 'Lithuanian', 'lt'],
  lo: ['Lào', 'Lao', 'lo'], mk: ['Macedonia', 'Macedonian', 'mk'],
  ml: ['Malayalam', 'Malayalam', 'ml'], ms: ['Malaysia', 'Malay', 'ms'],
  mt: ['Malta', 'Maltese', 'mt'], mr: ['Marathi', 'Marathi', 'mr'],
  my: ['Miến Điện', 'Burmese', 'my'], mn: ['Mông Cổ', 'Mongolian', 'mn'],
  nb: ['Na Uy', 'Norwegian', 'no'], ne: ['Nepal', 'Nepali', 'ne'],
  ru: ['Nga', 'Russian', 'ru'], ja: ['Nhật Bản', 'Japanese', 'ja'],
  ps: ['Pashto', 'Pashto', 'ps'], fil: ['Philippines', 'Filipino', 'tl'],
  fr: ['Pháp', 'French', 'fr'], fi: ['Phần Lan', 'Finnish', 'fi'],
  ro: ['Romania', 'Romanian', 'ro'], sr: ['Serbia', 'Serbian', 'sr'],
  si: ['Sinhala', 'Sinhala', 'si'], sk: ['Slovakia', 'Slovak', 'sk'],
  sl: ['Slovenia', 'Slovenian', 'sl'], so: ['Somali', 'Somali', 'so'],
  su: ['Sunda', 'Sundanese', 'su'], sw: ['Swahili', 'Swahili', 'sw'],
  cs: ['Séc', 'Czech', 'cs'], ta: ['Tamil', 'Tamil', 'ta'],
  te: ['Telugu', 'Telugu', 'te'], th: ['Thái Lan', 'Thai', 'th'],
  tr: ['Thổ Nhĩ Kỳ', 'Turkish', 'tr'], sv: ['Thụy Điển', 'Swedish', 'sv'],
  zh: ['Trung Quốc', 'Chinese', 'zh-CN'], es: ['Tây Ban Nha', 'Spanish', 'es'],
  uk: ['Ukraine', 'Ukrainian', 'uk'], ur: ['Urdu', 'Urdu', 'ur'],
  uz: ['Uzbekistan', 'Uzbek', 'uz'], vi: ['Việt Nam', 'Vietnamese', 'vi'],
  cy: ['Wales', 'Welsh', 'cy'], zu: ['Zulu', 'Zulu', 'zu'],
  it: ['Ý', 'Italian', 'it'], da: ['Đan Mạch', 'Danish', 'da'],
  de: ['Đức', 'German', 'de'], ar: ['Ả Rập', 'Arabic', 'ar']
});

const OUTPUT_LANGUAGES = Object.freeze(Object.keys(EDGE_LANGUAGE_VOICES).map((code) => {
  const [label, promptName, google] = OUTPUT_LANGUAGE_METADATA[code];
  return Object.freeze({ code, label, promptName, google });
}));

const OUTPUT_LANGUAGE_BY_CODE = Object.freeze(Object.fromEntries(
  OUTPUT_LANGUAGES.map((language) => [language.code, language])
));

function voiceDisplayName(id, gender) {
  const short = String(id).split('-').at(-1).replace(/Neural$/, '');
  return `${short} (${gender === 'male' ? 'Nam' : 'Nữ'})`;
}

const EDGE_VOICE_LIST = Object.freeze(Object.entries(EDGE_LANGUAGE_VOICES).flatMap(([lang, pair]) => [
  { id: pair[0], name: voiceDisplayName(pair[0], 'female'), lang, gender: 'female' },
  { id: pair[1], name: voiceDisplayName(pair[1], 'male'), lang, gender: 'male' }
]));

module.exports = {
  EDGE_LANGUAGE_VOICES,
  EDGE_VOICE_LIST,
  OUTPUT_LANGUAGES,
  OUTPUT_LANGUAGE_BY_CODE
};
