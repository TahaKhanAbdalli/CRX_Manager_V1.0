## 2026-10-27 - Outward check reads six full words; nested ids get their own hold files

- From Luna round 36 on PR #1152: the always-latch check for outward or destructive actions now reads six real words after the stop (a leading space used to take one slot), and session ids shaped as lists or objects are spelled with every number and string tagged, so differently shaped ids never share one hold file.
