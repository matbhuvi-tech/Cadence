import {
  splitMultiArtistCredits,
  isCompoundArtistException,
  generateMonogramAvatar,
} from '../core/taxonomyUtils'

console.log('--- Testing Artist Tokenizer & Compound Safeguards ---')

// Test 1: Conflated Artists Split Correctly
const test1 = splitMultiArtistCredits('Udit Narayan, Madhushree')
console.log('Test 1 (Udit Narayan, Madhushree):', test1.map((c) => c.name))
if (test1.length !== 2 || test1[0].name !== 'Udit Narayan' || test1[1].name !== 'Madhushree') {
  throw new Error(`Test 1 Failed: Expected 2 artists, got ${JSON.stringify(test1)}`)
}

// Test 2: Conjunctions with spacing
const test2 = splitMultiArtistCredits('Sonu Nigam & Kavita Krishnamurthy')
console.log('Test 2 (Sonu Nigam & Kavita Krishnamurthy):', test2.map((c) => c.name))
if (test2.length !== 2 || test2[0].name !== 'Sonu Nigam' || test2[1].name !== 'Kavita Krishnamurthy') {
  throw new Error(`Test 2 Failed: Expected 2 artists, got ${JSON.stringify(test2)}`)
}

// Test 3: Compound duo with standard hyphen
const test3 = splitMultiArtistCredits('Shankar-Ehsaan-Loy')
console.log('Test 3 (Shankar-Ehsaan-Loy):', test3.map((c) => c.name))
if (test3.length !== 1 || test3[0].name !== 'Shankar-Ehsaan-Loy') {
  throw new Error(`Test 3 Failed: Compound duo was incorrectly split!`)
}

// Test 4: Compound duo with spaces around hyphen
const test4 = splitMultiArtistCredits('Shankar - Ehsaan - Loy')
console.log('Test 4 (Shankar - Ehsaan - Loy):', test4.map((c) => c.name))
if (test4.length !== 1 || test4[0].name !== 'Shankar-Ehsaan-Loy') {
  throw new Error(`Test 4 Failed: Spaced hyphen was split!`)
}

// Test 5: Compound duo with en-dash (Salim–Sulaiman)
const test5 = splitMultiArtistCredits('Salim–Sulaiman')
console.log('Test 5 (Salim–Sulaiman):', test5.map((c) => c.name))
if (test5.length !== 1 || test5[0].name !== 'Salim–Sulaiman') {
  throw new Error(`Test 5 Failed: En-dash compound was split!`)
}

// Test 6: Compound duo with standard hyphen (Salim-Sulaiman)
const test6 = splitMultiArtistCredits('Salim-Sulaiman')
console.log('Test 6 (Salim-Sulaiman):', test6.map((c) => c.name))
if (test6.length !== 1 || test6[0].name !== 'Salim–Sulaiman') {
  throw new Error(`Test 6 Failed: Hyphen compound was split!`)
}

// Test 7: Word containing "with" substring must NOT be split (Bill Withers)
const test7 = splitMultiArtistCredits('Bill Withers')
console.log('Test 7 (Bill Withers):', test7.map((c) => c.name))
if (test7.length !== 1 || test7[0].name !== 'Bill Withers') {
  throw new Error(`Test 7 Failed: Bill Withers was split on substring 'with'!`)
}

// Test 8: Word containing "and" or compound (Anand-Milind)
const test8 = splitMultiArtistCredits('Anand-Milind')
console.log('Test 8 (Anand-Milind):', test8.map((c) => c.name))
if (test8.length !== 1 || test8[0].name !== 'Anand-Milind') {
  throw new Error(`Test 8 Failed: Anand-Milind was split on substring 'and'!`)
}

// Test 9: Featuring clause
const test9 = splitMultiArtistCredits('A. R. Rahman feat. Blaaze')
console.log('Test 9 (A. R. Rahman feat. Blaaze):', test9)
if (test9.length !== 2 || test9[0].name !== 'A. R. Rahman' || test9[1].name !== 'Blaaze' || test9[1].joinPhrase !== 'feat.') {
  throw new Error(`Test 9 Failed: Featuring clause failed!`)
}

// Test 10: Monogram Avatar generation
const avatarSvg = generateMonogramAvatar('A. R. Rahman')
if (!avatarSvg.startsWith('data:image/svg+xml') || !avatarSvg.includes('AR')) {
  throw new Error(`Test 10 Failed: Invalid monogram avatar SVG: ${avatarSvg}`)
}
console.log('Test 10 (Monogram Avatar): Success (length: ' + avatarSvg.length + ')')

console.log('All 10 Relational Tokenizer Tests Passed Perfectly!')
