-- DEV ONLY: seed sessions so the API can be exercised before wallet login (step 3) is used.
-- Addresses are real-format Stellar public keys with no secret kept anywhere: they can only be used through these dev sessions.
INSERT OR REPLACE INTO sessions (token, address, expires_at) VALUES
 ('dev-admin', 'GCFAMGZHLAYXI5HMLZQBUNJWELX3HT6CK7RZPB3A22PC774HTBW2VUV2', 4102444800),
 ('dev-verifier', 'GAQQRWBIZZ2CPMV2M3435UWU3STLAFVH2NM6EOBE5KSXQDHSSPQ67FZD', 4102444800),
 ('dev-artist', 'GABAA72CYM3LTRSMKHWCFRACEG75A7KY52335X57XC2ASQJQNE43FYG3', 4102444800),
 ('dev-artist2', 'GAAV4JCNBBU7IIOYJD6S6BPRS52DENEGWXQWYALHFCRBKHMUCB34K7MZ', 4102444800),
 ('dev-collector', 'GBFINNVVXYSWSYBGKZYGPOC2UDKUC2ZNPEK5IJPME2K4WOOC6GUEUXNH', 4102444800);
