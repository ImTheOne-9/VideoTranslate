# -*- coding: utf-8 -*-
"""Vietnamese TTS normalization fallback used by the Piper bridge.

This mirrors the number/date/money normalizer used by the reference pipeline.
The optional ``vietnormalizer`` package remains the preferred path because it
also transliterates English words for small Vietnamese Piper voices.
"""

import re


_DIGITS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"]
_SCALE = ["", " nghìn", " triệu", " tỷ"]
_ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}


def _read_three(value, full):
    hundreds, remainder = divmod(value, 100)
    tens, units = divmod(remainder, 10)
    parts = []
    if hundreds > 0 or full:
        parts.append(_DIGITS[hundreds] + " trăm")
    if tens == 0:
        if units > 0:
            parts.append(("lẻ " + _DIGITS[units]) if (hundreds > 0 or full) else _DIGITS[units])
    elif tens == 1:
        parts.append("mười" if units == 0 else ("mười lăm" if units == 5 else "mười " + _DIGITS[units]))
    else:
        text = _DIGITS[tens] + " mươi"
        if units == 1:
            text += " mốt"
        elif units == 4:
            text += " tư"
        elif units == 5:
            text += " lăm"
        elif units > 0:
            text += " " + _DIGITS[units]
        parts.append(text)
    return " ".join(parts).strip()


def read_integer(value):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return str(value)
    if number == 0:
        return "không"
    negative = number < 0
    number = abs(number)
    groups = []
    while number > 0:
        number, group = divmod(number, 1000)
        groups.append(group)
    output = []
    for index in range(len(groups) - 1, -1, -1):
        group = groups[index]
        if group == 0:
            continue
        full = index != len(groups) - 1
        if index < len(_SCALE):
            scale = _SCALE[index]
        else:
            scale = ["", " nghìn", " triệu"][index % 3] + (" tỷ" * (index // 3))
        output.append(_read_three(group, full) + scale)
    text = " ".join(output).strip()
    return ("âm " + text) if negative else text


def _read_digits(value):
    return " ".join(_DIGITS[int(char)] for char in str(value) if char.isdigit())


def _roman_to_integer(value):
    roman = str(value).upper()
    if not roman or not re.fullmatch(r"M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})", roman):
        return None
    total = previous = 0
    for char in reversed(roman):
        current = _ROMAN[char]
        total += -current if current < previous else current
        previous = max(previous, current)
    return total


def normalize(text):
    """Normalize Vietnamese numbers for TTS without changing display text."""
    if not text or not any(char.isdigit() for char in text):
        return text
    value = " " + str(text) + " "
    for _ in range(4):
        value = re.sub(r"\d{1,3}(?:\.\d{3})+", lambda match: match.group(0).replace(".", ""), value)
    value = re.sub(
        r"\b(?:ngày\s+)?(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b",
        lambda match: "ngày %s tháng %s năm %s" % tuple(read_integer(match.group(i)) for i in (1, 2, 3)),
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(
        r"\b(\d{1,2})[/-](\d{4})\b",
        lambda match: "tháng %s năm %s" % (read_integer(match.group(1)), read_integer(match.group(2))),
        value,
    )
    value = re.sub(
        r"\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b",
        lambda match: "%s giờ %s phút" % (read_integer(match.group(1)), read_integer(match.group(2)))
        + ((" %s giây" % read_integer(match.group(3))) if match.group(3) else ""),
        value,
    )
    value = re.sub(
        r"\b(\d{1,2})h(\d{2})\b",
        lambda match: "%s giờ %s phút" % (read_integer(match.group(1)), read_integer(match.group(2))),
        value,
        flags=re.IGNORECASE,
    )

    def replace_roman(match):
        parsed = _roman_to_integer(match.group(1))
        return read_integer(parsed) if parsed else match.group(0)

    value = re.sub(r"(?<![\wÀ-ỹ])([IVXLCDM]{2,})(?![\wÀ-ỹ])", replace_roman, value)
    value = re.sub(r"\$\s*(\d+)", lambda match: read_integer(match.group(1)) + " đô la", value)
    value = re.sub(r"€\s*(\d+)", lambda match: read_integer(match.group(1)) + " ơ-rô", value)
    value = re.sub(
        r"(\d+)\s*(?:đồng|VND|VNĐ|vnđ|đ)\b",
        lambda match: read_integer(match.group(1)) + " đồng",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(
        r"(\d+)\s*[-–—]\s*(\d+)\s*%",
        lambda match: "%s đến %s phần trăm" % (read_integer(match.group(1)), read_integer(match.group(2))),
        value,
    )
    value = re.sub(r"(\d+)\s*%", lambda match: read_integer(match.group(1)) + " phần trăm", value)
    value = re.sub(
        r"(\d+),(\d+)",
        lambda match: "%s phẩy %s" % (read_integer(match.group(1)), _read_digits(match.group(2))),
        value,
    )
    value = re.sub(
        r"(\d+)\s*[-–—]\s*(\d+)",
        lambda match: "%s đến %s" % (read_integer(match.group(1)), read_integer(match.group(2))),
        value,
    )
    value = re.sub(r"\b0\d{9,10}\b", lambda match: _read_digits(match.group(0)), value)
    value = re.sub(r"(?<![\d\w])-\s*(\d+)", lambda match: "âm " + read_integer(match.group(1)), value)
    value = re.sub(r"\d+", lambda match: read_integer(match.group(0)), value)
    return re.sub(r"\s+", " ", value).strip()


# Keep the reference module's public function name for a drop-in fallback.
chuan_hoa = normalize
