import antfu from '@antfu/eslint-config';

export default antfu({
	ignores: ['public/**', 'dist/**', 'eslint.config.js'],
	typescript: {
		overrides: {
			'@typescript-eslint/no-explicit-any': 'off',
			'antfu/top-level-function': 'off',
			'no-console': 'off',
			'perfectionist/sort-imports': 'off',
			'ts/method-signature-style': 'off',
			'unused-imports/no-unused-vars': 'warn',
		},
	},
	stylistic: {
		indent: 'tab',
		quotes: 'single',
		semi: true,
	},
});
