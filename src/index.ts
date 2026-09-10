const targetRepository = process.argv.slice(2).find((argument) => !argument.startsWith('--'));

if (!targetRepository) {
  console.error('Usage: npm start -- <repository-path>');
  process.exit(1);
}

console.log('Graphentra Analyzer started');
console.log('Repository to analyze:', targetRepository);
