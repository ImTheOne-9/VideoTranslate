'use strict';

// Tốc độ từ/giây được ViralCrawl đo trực tiếp trên audio CapCut. Chỉ dùng
// một chiều để siết bản dịch cho giọng chậm; giọng nhanh không được phép
// nới câu dài hơn trần chung của ngôn ngữ.
const MEASURED_VOICE_WPS = Object.freeze({
  BV570_streaming: 1.93,
  BV080_streaming: 2.15,
  de_001: 2.14,
  DiT_de_female_qingsong: 2.09,
  DiT_de_male_koubo: 2.04,
  DiT_de_female_jiangshi: 1.93,
  ICL_en_female_cm: 3.16,
  en_male_xudong_conversation_wvae_bigtts_cc: 2.70,
  pNInz6obpgDQGcFmaJgB: 2.62,
  TxGEqnHWrfWFTfGW9XjX: 2.41,
  g5CIjZEefAph4nQFvHAz: 2.09,
  ICL_es_male_jiqiren: 3.78,
  sKgg4MPUDBy69X7iv3fA: 3.50,
  DiT_es_male_agenting: 3.43,
  DiT_es_female_bilunv: 3.28,
  DiT_es_male_bilunan: 3.14,
  '2rigMbVWLdqtBSCahJFX': 2.83,
  ICL_es_male_emo: 2.79,
  KHCvMklQZZo0O30ERnVn: 2.77,
  BV078_streaming: 3.70,
  DiT_fr_female_sharp: 3.51,
  aQROLel5sQbj1vuIVi6B: 3.49,
  fr_002: 3.35,
  b6nVfb3l2zshrLZTvqbs: 3.34,
  j9RedbMRSNQ74PyikQwD: 3.30,
  DiT_fr_female_soothing: 2.97,
  DiT_fr_male_wit: 2.96,
  BV192_streaming: 2.78,
  id_female_icha_uranus_bigtts: 2.62,
  ICL_id_male_deep_god_dsp: 2.49,
  id_male_putra_uranus_bigtts: 2.41,
  ICL_id_male_boy_budi: 2.25,
  ICL_id_female_hantuperempuan: 1.86,
  ICL_id_male_scared: 1.85,
  ICL_id_male_sad: 1.78,
  BV087_streaming: 3.03,
  kr_004: 1.93,
  BV545_streaming: 1.88,
  BV066_streaming: 1.70,
  BV546_streaming: 1.57,
  BV059_streaming: 1.50,
  DiT_pt_male_wenrou: 3.29,
  ICL_br_male_211M_RodrigoA3: 2.82,
  DiT_pt_male_shangren: 2.81,
  ICL_br_male_201M_CaioS: 2.81,
  br_004: 2.74,
  ICL_br_female_216F_YamaH: 2.65,
  DiT_pt_female_youya: 2.52,
  ICL_br_male_212M_LuizS: 2.47,
  BV068_streaming: 1.91,
  BV083_streaming: 2.87,
  BV074_streaming: 4.80,
  BV421_vivn_streaming: 4.72,
  BV075_streaming: 4.48,
  ueSxRO0nLF1bj93J2hVt: 4.23,
  multi_female_richgirl_uranus_bigtts: 3.86,
  '1d5Bb0SMBPB10Gx6iQeu': 3.79,
  '7hsfEc7irDn6E8br0qfw': 3.75,
  pGapy9MNHCukzJtjavF0: 3.67,
  '9EE00wK5qV6tPtpQIxvy': 3.58,
  xPEfmymXC4WdBxGMznS7: 3.55
});

function measuredVoiceWordsPerSecond(voiceId) {
  const value = MEASURED_VOICE_WPS[String(voiceId || '').trim()];
  return Number.isFinite(value) && value > 0 ? value : null;
}

module.exports = {
  MEASURED_VOICE_WPS,
  measuredVoiceWordsPerSecond
};
