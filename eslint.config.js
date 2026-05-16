import apify from '@apify/eslint-config';

// eslint-disable-next-line import-x/no-default-export
export default [
    ...apify,
    {
        ignores: ['node_modules', 'storage', 'dist'],
    },
];

