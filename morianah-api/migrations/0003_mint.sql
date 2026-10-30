-- Step 4: mint bookkeeping
ALTER TABLE submissions ADD COLUMN image_cid TEXT;      -- IPFS CID of the image file (metadata CID is `cid`)
ALTER TABLE submissions ADD COLUMN mint_tx  TEXT;       -- Stellar transaction hash, when reported by the wallet
ALTER TABLE submissions ADD COLUMN minted_at INTEGER;
