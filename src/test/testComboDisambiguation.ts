import { disambiguateComboTitle } from '../core/taxonomyUtils'

console.log('=== [TDD] Testing Universal Combo CD Disambiguation Engine ===\n')

const testCases = [
  {
    tag: 'Chinna Thambi/Dharma Dorai/Captian Prabhakaran',
    folder: 'Dharma Dorai CD RIP',
    expectedTitle: 'Dharma Dorai',
    expectedCombo: true,
  },
  {
    tag: 'Chinna Thambi/Dharma Dorai/Captian Prabhakaran',
    folder: 'Captain Prabhakaran CD RIP',
    expectedTitle: 'Captian Prabhakaran',
    expectedCombo: true,
  },
  {
    tag: 'Chinna Thambi/Dharma Dorai/Captian Prabhakaran',
    folder: 'Chinna Thambi CD RIP',
    expectedTitle: 'Chinna Thambi',
    expectedCombo: true,
  },
  {
    tag: 'Rettai Vaal Kuruvi / Theertha Karayinile / Kannukku Mai Ezhuthu',
    folder: 'Theertha Karayinile CD RIP',
    expectedTitle: 'Theertha Karayinile',
    expectedCombo: true,
  },
  {
    tag: 'Rettai Vaal Kuruvi / Theertha Karayinile / Kannukku Mai Ezhuthu',
    folder: 'Kannukku Mai Ezhuthu CD RIP',
    expectedTitle: 'Kannukku Mai Ezhuthu',
    expectedCombo: true,
  },
  {
    tag: 'Arengetra Velai / Aanand / En Jeevan Paaduthe',
    folder: 'Anand CD RIP',
    expectedTitle: 'Aanand',
    expectedCombo: true,
  },
  {
    tag: 'Dharmathin Thalaivan/Kizhakku Vasal /Chatriyan',
    folder: 'Chatriyan CD RIP v2.0',
    expectedTitle: 'Chatriyan',
    expectedCombo: true,
  },
  // Single album protection tests
  {
    tag: 'Face/Off (Soundtrack)',
    folder: 'Face Off (1997)',
    expectedTitle: 'Face/Off (Soundtrack)',
    expectedCombo: false,
  },
  {
    tag: 'Back in Black',
    folder: 'AC/DC - Back in Black',
    expectedTitle: 'Back in Black',
    expectedCombo: false,
  },
  // Unified combo CD folder (not split by user)
  {
    tag: 'Chinna Thambi / Dharma Dorai',
    folder: 'Chinna Thambi & Dharma Dorai [CD]',
    expectedTitle: 'Chinna Thambi / Dharma Dorai',
    expectedCombo: false,
  },
  // Hyphen-separated 3-in-1 combo CD
  {
    tag: 'Needhana Andak Kuyil - Moondraam Pirai - Pakal Nilavu',
    folder: 'Moondraam Pirai CD RIP',
    expectedTitle: 'Moondraam Pirai',
    expectedCombo: true,
  },
  {
    tag: 'Needhana Andak Kuyil - Moondraam Pirai - Pakal Nilavu',
    folder: 'Needhana Andak Kuyil CD RIP',
    expectedTitle: 'Needhana Andak Kuyil',
    expectedCombo: true,
  },
  {
    tag: 'Needhana Andak Kuyil - Moondraam Pirai - Pakal Nilavu',
    folder: 'Pakal Nilavu CD RIP',
    expectedTitle: 'Pakal Nilavu',
    expectedCombo: true,
  },
]

let passed = 0
testCases.forEach((tc, idx) => {
  const result = disambiguateComboTitle(tc.tag, tc.folder)
  const ok = result.resolvedTitle === tc.expectedTitle && result.isCombo === tc.expectedCombo
  if (ok) {
    console.log(`[PASS] Case ${idx + 1}: Folder '${tc.folder}' -> Resolved: '${result.resolvedTitle}' (isCombo=${result.isCombo})`)
    passed++
  } else {
    console.error(`[FAIL] Case ${idx + 1}: Folder '${tc.folder}' -> Got: '${result.resolvedTitle}' (isCombo=${result.isCombo}), Expected: '${tc.expectedTitle}' (isCombo=${tc.expectedCombo})`)
  }
})

console.log(`\nResults: ${passed}/${testCases.length} Passed!`)
if (passed === testCases.length) {
  console.log('🎉 ALL COMBO DISAMBIGUATION TESTS PASSED!')
} else {
  process.exit(1)
}
