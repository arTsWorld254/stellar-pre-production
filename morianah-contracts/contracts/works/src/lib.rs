#![no_std]

mod contract;

pub use contract::{MorianahWorks, MorianahWorksClient, Work, WorksError, ROLE_ARTIST, ROLE_VERIFIER};

#[cfg(test)]
mod test;
