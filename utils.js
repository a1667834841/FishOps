/**
 * utils.js - 公共工具函数模块
 * 提供 MD5 哈希等常用功能
 */

// ==================== MD5 哈希算法实现 ====================

/**
 * 计算字符串的 MD5 哈希值
 * @param {string} string - 输入字符串
 * @returns {string} 32位小写十六进制 MD5 哈希值
 */
function md5(string) {
    function rotateLeft(value, shift) {
        return (value << shift) | (value >>> (32 - shift));
    }

    function addUnsigned(x, y) {
        const x8 = x & 0x80000000, y8 = y & 0x80000000;
        const x4 = x & 0x40000000, y4 = y & 0x40000000;
        const result = (x & 0x3FFFFFFF) + (y & 0x3FFFFFFF);
        if (x4 & y4) return result ^ 0x80000000 ^ x8 ^ y8;
        if (x4 | y4) {
            if (result & 0x40000000) return result ^ 0xC0000000 ^ x8 ^ y8;
            return result ^ 0x40000000 ^ x8 ^ y8;
        }
        return result ^ x8 ^ y8;
    }

    function F(x, y, z) { return (x & y) | (~x & z); }
    function G(x, y, z) { return (x & z) | (y & ~z); }
    function H(x, y, z) { return x ^ y ^ z; }
    function I(x, y, z) { return y ^ (x | ~z); }

    function convertToWordArray(str) {
        const utf8 = unescape(encodeURIComponent(str));
        const len = utf8.length;
        const words = [];
        for (let i = 0; i < len; i += 4) {
            words.push(
                (utf8.charCodeAt(i) || 0) |
                ((utf8.charCodeAt(i + 1) || 0) << 8) |
                ((utf8.charCodeAt(i + 2) || 0) << 16) |
                ((utf8.charCodeAt(i + 3) || 0) << 24)
            );
        }
        const bitLen = len * 8;
        words[len >> 2] |= 0x80 << ((len % 4) * 8);
        words[(((len + 8) >>> 6) << 4) + 14] = bitLen;
        return words;
    }

    function wordToHex(value) {
        let hex = '';
        for (let i = 0; i < 4; i++) {
            hex += ((value >> (i * 8)) & 0xFF).toString(16).padStart(2, '0');
        }
        return hex;
    }

    const x = convertToWordArray(string);
    let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const K = [
        0xD76AA478, 0xE8C7B756, 0x242070DB, 0xC1BDCEEE, 0xF57C0FAF, 0x4787C62A, 0xA8304613, 0xFD469501,
        0x698098D8, 0x8B44F7AF, 0xFFFF5BB1, 0x895CD7BE, 0x6B901122, 0xFD987193, 0xA679438E, 0x49B40821,
        0xF61E2562, 0xC040B340, 0x265E5A51, 0xE9B6C7AA, 0xD62F105D, 0x02441453, 0xD8A1E681, 0xE7D3FBC8,
        0x21E1CDE6, 0xC33707D6, 0xF4D50D87, 0x455A14ED, 0xA9E3E905, 0xFCEFA3F8, 0x676F02D9, 0x8D2A4C8A,
        0xFFFA3942, 0x8771F681, 0x6D9D6122, 0xFDE5380C, 0xA4BEEA44, 0x4BDECFA9, 0xF6BB4B60, 0xBEBFBC70,
        0x289B7EC6, 0xEAA127FA, 0xD4EF3085, 0x04881D05, 0xD9D4D039, 0xE6DB99E5, 0x1FA27CF8, 0xC4AC5665,
        0xF4292244, 0x432AFF97, 0xAB9423A7, 0xFC93A039, 0x655B59C3, 0x8F0CCC92, 0xFFEFF47D, 0x85845DD1,
        0x6FA87E4F, 0xFE2CE6E0, 0xA3014314, 0x4E0811A1, 0xF7537E82, 0xBD3AF235, 0x2AD7D2BB, 0xEB86D391
    ];

    for (let k = 0; k < x.length; k += 16) {
        const AA = a, BB = b, CC = c, DD = d;
        for (let i = 0; i < 64; i++) {
            let f, g;
            if (i < 16) { f = F(b, c, d); g = i; }
            else if (i < 32) { f = G(b, c, d); g = (5 * i + 1) % 16; }
            else if (i < 48) { f = H(b, c, d); g = (3 * i + 5) % 16; }
            else { f = I(b, c, d); g = (7 * i) % 16; }
            const temp = d;
            d = c; c = b;
            b = addUnsigned(b, rotateLeft(addUnsigned(addUnsigned(a, f), addUnsigned(K[i], x[k + g] || 0)), S[(Math.floor(i / 16) * 4) + (i % 4)]));
            a = temp;
        }
        a = addUnsigned(a, AA); b = addUnsigned(b, BB); c = addUnsigned(c, CC); d = addUnsigned(d, DD);
    }

    return wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d);
}

// 导出供其他模块使用
// 支持 Service Worker (self) 和页面环境 (window)
var FishOpsUtils = {
    md5: md5
};

// Service Worker 环境
if (typeof self !== 'undefined') {
    self.FishOpsUtils = FishOpsUtils;
}

// 页面环境
if (typeof window !== 'undefined') {
    window.FishOpsUtils = FishOpsUtils;
}
